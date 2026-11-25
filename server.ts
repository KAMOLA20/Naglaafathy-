import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AcademyProfile,
  AcademySnapshot,
  ActivationCode,
  Announcement,
  Certificate,
  ChatMessage,
  Course,
  Exam,
  ExamAttempt,
  FawryOrder,
  FawryStatus,
  GradeLevel,
  LecturePushEvent,
  Lesson,
  LessonAttendance,
  LessonReview,
  LiveLectureSchedule,
  Student,
  SubjectBranch,
  TeacherPayoutSettings,
  TeacherWalletTransaction,
  TopupMethod,
  WalletRequest,
} from './src/types.ts';
import { createCloudStore } from './src/server/cloudStore.ts';
import { applyMonthlySyllabusToCourses } from './src/server/monthlySyllabus.ts';
import { buildZipBuffer } from './src/server/zipBuilder.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'academy-naglaa-v2-store.json');

interface CredentialRecord {
  id: string;
  phone: string;
  passwordHash: string;
}

interface SessionRecord {
  token: string;
  studentId: string;
  createdAt: string;
}

interface PersistedAcademyStore extends AcademySnapshot {
  credentials: CredentialRecord[];
  sessions: SessionRecord[];
}

function getFawryConfig() {
  const merchantCode = String(process.env.FAWRY_MERCHANT_CODE || '').trim();
  const securityKey = String(process.env.FAWRY_SECURITY_KEY || '').trim();
  const envMode = String(process.env.FAWRY_ENV || 'sandbox').trim().toLowerCase();
  const configured = Boolean(merchantCode && securityKey);
  const mode: 'live' | 'sandbox' = configured && envMode === 'production' ? 'live' : 'sandbox';
  const apiBase =
    envMode === 'production'
      ? 'https://www.atfawry.com/ECommerceWeb/Fawry/payments'
      : 'https://atfawry.fawrystaging.com/ECommerceWeb/Fawry/payments';
  return { merchantCode, securityKey, configured, mode, apiBase };
}

function getFawryStatus(): FawryStatus {
  const cfg = getFawryConfig();
  return {
    configured: cfg.configured,
    mode: cfg.mode,
    merchantCodeMasked: cfg.merchantCode
      ? `${cfg.merchantCode.slice(0, 3)}***${cfg.merchantCode.slice(-2)}`
      : undefined,
  };
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (!normA || normA.length !== normB.length) return false;
  return crypto.timingSafeEqual(Buffer.from(normA, 'utf8'), Buffer.from(normB, 'utf8'));
}

function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.startsWith('20') && digits.length === 12) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function isCourseUnlockedForStudent(course: Course, student: Student | null): boolean {
  if (course.priceEgp === 0) return true;
  return Boolean(student && student.enrolledCourseIds.includes(course.id));
}

function getVerifiedAttendedCount(
  store: PersistedAcademyStore,
  studentId: string,
  course: Course
): number {
  return course.lessons.filter((lesson) => {
    const att = store.attendances.find(
      (a) => a.studentId === studentId && a.lessonId === lesson.id
    );
    return Boolean(att && att.checkedIn && att.fullyWatched);
  }).length;
}

function ensureCourseCertificate(
  store: PersistedAcademyStore,
  student: Student,
  course: Course,
  awardBonusPoints: boolean
): { issued: boolean; certificate: Certificate | null } {
  if (!isCourseUnlockedForStudent(course, student)) {
    return { issued: false, certificate: null };
  }
  const totalLessons = course.lessons.length;
  if (totalLessons === 0) {
    return { issued: false, certificate: null };
  }
  const completedCount = course.lessons.filter((l) =>
    student.completedLessonIds.includes(l.id)
  ).length;
  const attendedCount = getVerifiedAttendedCount(store, student.id, course);
  if (completedCount < totalLessons || attendedCount < totalLessons) {
    return { issued: false, certificate: null };
  }

  const existing = store.certificates.find(
    (c) => c.studentId === student.id && c.courseId === course.id
  );
  if (existing) {
    return { issued: false, certificate: existing };
  }

  const serialCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  const cert: Certificate = {
    id: `cert-${Date.now()}-${serialCode}`,
    certificateNumber: `NG-${new Date().getFullYear()}-${serialCode}`,
    studentId: student.id,
    studentName: student.name,
    courseId: course.id,
    courseTitle: course.title,
    grade: course.grade,
    branch: course.branch,
    monthLabel: course.monthLabel,
    completedLessonsCount: completedCount,
    totalLessonsCount: totalLessons,
    teacherName: store.profile.teacherName,
    platformName: store.profile.platformName,
    issuedAt: new Date().toISOString(),
  };

  store.certificates.unshift(cert);
  if (awardBonusPoints) {
    student.points += 100;
  }
  return { issued: true, certificate: cert };
}

function syncAllEligibleCertificates(store: PersistedAcademyStore): void {
  store.students.forEach((student) => {
    store.courses.forEach((course) => {
      ensureCourseCertificate(store, student, course, false);
    });
  });
}

function recordPaymentToTeacherWallet(
  store: PersistedAcademyStore,
  params: {
    amountEgp: number;
    sourceMethod: TeacherWalletTransaction['sourceMethod'];
    student?: Student | null;
    course?: Course | null;
    referenceNumber: string;
    note: string;
  }
): { credited: TeacherWalletTransaction; autoPayout?: TeacherWalletTransaction } | null {
  const amount = Math.round(Number(params.amountEgp || 0));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const nowIso = new Date().toISOString();
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  const credited: TeacherWalletTransaction = {
    id: `tx-in-${Date.now()}-${suffix}`,
    type: 'student_payment',
    amountEgp: amount,
    sourceMethod: params.sourceMethod,
    studentId: params.student?.id,
    studentName: params.student?.name,
    courseId: params.course?.id,
    courseTitle: params.course?.title,
    referenceNumber: params.referenceNumber,
    status: 'credited',
    note: params.note,
    createdAt: nowIso,
  };

  store.teacherTotalCollectedEgp = Number((store.teacherTotalCollectedEgp + amount).toFixed(2));
  store.teacherTransactions.unshift(credited);

  let autoPayout: TeacherWalletTransaction | undefined;
  if (store.payoutSettings.autoTransferEnabled) {
    const destPhone = normalizePhone(store.payoutSettings.destinationPhone || store.profile.hotline) || '01029121467';
    const destMethodLabel =
      store.payoutSettings.destinationMethod === 'instapay'
        ? 'إنستاباي'
        : store.payoutSettings.destinationMethod === 'fawry'
          ? 'حساب فوري'
          : 'فودافون كاش';
    autoPayout = {
      id: `tx-out-${Date.now()}-${suffix}`,
      type: 'auto_payout',
      amountEgp: amount,
      sourceMethod: params.sourceMethod,
      studentId: params.student?.id,
      studentName: params.student?.name,
      courseId: params.course?.id,
      courseTitle: params.course?.title,
      destinationPhone: destPhone,
      referenceNumber: `PAYOUT-${suffix}-${Date.now().toString().slice(-4)}`,
      status: 'transferred',
      note: `تحويل تلقائي فوري عبر ${destMethodLabel} إلى ${destPhone}`,
      createdAt: new Date(Date.now() + 1).toISOString(),
    };
    store.teacherTotalTransferredEgp = Number((store.teacherTotalTransferredEgp + amount).toFixed(2));
    store.teacherTransactions.unshift(autoPayout);
  } else {
    store.teacherWalletBalance = Number((store.teacherWalletBalance + amount).toFixed(2));
  }

  if (store.teacherTransactions.length > 250) {
    store.teacherTransactions = store.teacherTransactions.slice(0, 250);
  }
  return { credited, autoPayout };
}

function createDefaultLectureSchedules(
  courses: Course[],
  teacherName: string
): LiveLectureSchedule[] {
  const now = Date.now();
  const findCourse = (id: string) => courses.find((c) => c.id === id) || courses[0];
  const c1 = findCourse('crs-p4-ar');
  const c2 = findCourse('crs-p1-ar');
  const c3 = findCourse('crs-kg-ar');

  return [
    {
      id: 'sch-live-1',
      courseId: c1.id,
      courseTitle: c1.title,
      lessonId: c1.lessons[0]?.id,
      lessonTitle: c1.lessons[0]?.title || 'مراجعة النحو وتدريبات القراءة',
      grade: c1.grade,
      branch: c1.branch,
      teacherName,
      scheduledAt: new Date(now + 10 * 60_000).toISOString(),
      durationMin: 40,
      remindBeforeMin: 15,
      note: 'جهز دفتر الملاحظات لحل تدريبات الدرس مع الشرح الكرتوني التفاعلي.',
      createdAt: new Date(now - 3_600_000).toISOString(),
    },
    {
      id: 'sch-live-2',
      courseId: c2.id,
      courseTitle: c2.title,
      lessonId: c2.lessons[0]?.id,
      lessonTitle: c2.lessons[0]?.title || 'الحركات القصيرة والمدود',
      grade: c2.grade,
      branch: c2.branch,
      teacherName,
      scheduledAt: new Date(now + 35 * 60_000).toISOString(),
      durationMin: 30,
      remindBeforeMin: 15,
      note: 'محاضرة تأسيس مجانية مفتوحة لجميع طلاب الصف الأول الابتدائي.',
      createdAt: new Date(now - 3_600_000).toISOString(),
    },
    {
      id: 'sch-live-3',
      courseId: c3.id,
      courseTitle: c3.title,
      lessonId: c3.lessons[0]?.id,
      lessonTitle: c3.lessons[0]?.title || 'نور البيان وقصة الحروف',
      grade: c3.grade,
      branch: c3.branch,
      teacherName,
      scheduledAt: new Date(now + 120 * 60_000).toISOString(),
      durationMin: 25,
      remindBeforeMin: 20,
      note: 'بمشاركة الرسوم المتحركة وصوت الأستاذة نجلاء فتحي لأطفال KG.',
      createdAt: new Date(now - 3_600_000).toISOString(),
    },
  ];
}

function createDefaultLessonReviews(
  courses: Course[],
  students: Student[]
): LessonReview[] {
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const build = (
    id: string,
    studentId: string,
    courseId: string,
    lessonId: string,
    audioRating: number,
    contentRating: number,
    comment: string,
    days: number
  ): LessonReview | null => {
    const stu = students.find((s) => s.id === studentId);
    const crs = courses.find((c) => c.id === courseId);
    const les = crs?.lessons.find((l) => l.id === lessonId);
    if (!stu || !crs || !les) return null;
    return {
      id,
      studentId: stu.id,
      studentName: stu.name,
      courseId: crs.id,
      courseTitle: crs.title,
      lessonId: les.id,
      lessonTitle: les.title,
      grade: crs.grade,
      branch: crs.branch,
      audioRating,
      contentRating,
      overallRating: Number(((audioRating + contentRating) / 2).toFixed(1)),
      comment,
      createdAt: daysAgo(days),
    };
  };

  return [
    build(
      'rev-1',
      'stu-demo',
      'crs-p1-ar',
      'les-p1-ar-1',
      5,
      5,
      'الشرح الصوتي للأستاذة نجلاء واضح جداً والرسوم المتحركة ساعدت أخي الصغير يفهم الحركات بسهولة.',
      3
    ),
    build(
      'rev-2',
      'stu-2',
      'crs-p6-ar',
      'les-p6-ar-1',
      5,
      5,
      'ممتاز في شرح النحو والإعراب مع أمثلة السبورة والملزمة المنظمة.',
      2
    ),
    build(
      'rev-3',
      'stu-2',
      'crs-p6-ma',
      'les-p6-ma-1',
      4,
      5,
      'الأمثلة المتدرجة في الرياضيات رائعة ووضحت لي خطوات الحل بسرعة.',
      2
    ),
    build(
      'rev-4',
      'stu-3',
      'crs-kg-ar',
      'les-kg-ar-1',
      5,
      5,
      'ابني أحب فيديو الحروف المتحرك وصوت المعلمة ممتاز جداً لسن رياض الأطفال.',
      1
    ),
    build(
      'rev-5',
      'stu-4',
      'crs-p3-ar',
      'les-p3-ar-1',
      4,
      4,
      'درس جميل وشرح مبسط وتدريبات مفيدة بعد الفيديو.',
      1
    ),
  ].filter((r): r is LessonReview => r !== null);
}

function createInitialStore(): PersistedAcademyStore {
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  const profile: AcademyProfile = {
    platformName: 'منصة الأستاذة نجلاء فتحي',
    teacherName: 'الأستاذة نجلاء فتحي',
    teacherTitle: 'معلمة اللغة العربية والرياضيات للمرحلة الابتدائية وتأسيس رياض الأطفال',
    teacherBio:
      'شرح صوتي ومرئي مبسط لدروس اللغة العربية والرياضيات من الصف الأول حتى السادس الابتدائي، مع إمكانية تنزيل المنهج كاملاً لكل مادة وقسم خاص لتأسيس أطفال KG1 و KG2 في جميع المواد.',
    hotline: '01029121467',
    academicYear: 'العام الدراسي 2026 / 2027',
  };

  const ARABIC_IMG = '/src/assets/images/course_arabic_primary_1795354179025.jpg';
  const MATH_IMG = '/src/assets/images/course_math_primary_1795354180095.jpg';
  const KG_IMG = '/src/assets/images/kg_foundation_banner_1795354180015.jpg';
  const HERO_IMG = '/src/assets/images/primary_hero_banner_1795354179862.jpg';

  const courses: Course[] = [
    // الصف الأول الابتدائي
    {
      id: 'crs-p1-ar',
      title: 'اللغة العربية — الصف الأول الابتدائي (كورس التأسيس المجاني)',
      subtitle: 'الحروف بالحركات القصيرة، المدود الثلاثة، الشدة والتنوين، وقراءة الجمل البسيطة.',
      grade: 'p1',
      branch: 'arabic',
      monthLabel: 'أولى ابتدائي · عربي',
      priceEgp: 0,
      coverImage: ARABIC_IMG,
      totalHours: 8,
      examId: 'exam-p1-ar',
      lessons: [
        {
          id: 'les-p1-ar-1',
          order: 1,
          title: 'الحركات القصيرة: الفتحة والضمة والكسرة',
          durationMin: 25,
          videoSummary: 'نطق الحروف الهجائية بالحركات القصيرة وتمييز الصوت القصير داخل الكلمات.',
          keyFormulas: ['بَ (فتحة)  ·  بُ (ضمة)  ·  بِ (كسرة)'],
          slides: [
            {
              heading: 'كيف ننطق الحركات القصيرة؟',
              formula: 'أَ (أَسَد)  |  أُ (أُذُن)  |  إِ (إِبْرَة)',
              note: 'الفتحة نفتح بها الفم، والضمة نضم بها الشفتين، والكسرة نكسر بها الصوت لأسفل.',
            },
            {
              heading: 'تحليل الكلمة إلى أصوات',
              formula: 'كَـ + تَـ + بَ = كَتَبَ',
              note: 'كل حرف متحرك بحركة قصيرة يُكتب في مقطع صوتي مستقل.',
            },
          ],
          handoutTitle: 'كراسة الحركات القصيرة — أولى ابتدائي',
          handoutSummary: 'تدريبات توصيل وتلوين وتحليل كلمات من 3 حروف.',
          isFreePreview: true,
        },
        {
          id: 'les-p1-ar-2',
          order: 2,
          title: 'حروف المد الثلاثة (الألف والواو والياء)',
          durationMin: 28,
          videoSummary: 'الفرق بين الحركة القصيرة وحرف المد، وتحديد الحرف الممدود بدقة.',
          keyFormulas: ['مَدّ بالألف: قَالَ', 'مَدّ بالواو: يَقُولُ', 'مَدّ بالياء: سَعِيدٌ'],
          slides: [
            {
              heading: 'شروط حرف المد الصحيح',
              formula: 'المد لا يأتي في أول الكلمة ولا توضع عليه حركة',
              note: 'المد بالألف يحب الفتحة قبله، والمد بالواو يحب الضمة، والمد بالياء يحب الكسرة.',
            },
          ],
          handoutTitle: 'تدريبات المد والممدود',
          handoutSummary: '20 كلمة استخراج حرف المد والحرف الممدود.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-p1-ma',
      title: 'الرياضيات — الصف الأول الابتدائي (الأعداد والجمع والطرح)',
      subtitle: 'الأعداد حتى 100، القيمة المكانية (الآحاد والعشرات)، ومهارات الجمع والطرح الذهني.',
      grade: 'p1',
      branch: 'math',
      monthLabel: 'أولى ابتدائي · رياضة',
      priceEgp: 120,
      coverImage: MATH_IMG,
      totalHours: 9,
      examId: 'exam-p1-ma',
      lessons: [
        {
          id: 'les-p1-ma-1',
          order: 1,
          title: 'مكونات العدد 10 والجمع بالمضاعفة (حصة مجانية)',
          durationMin: 24,
          videoSummary: 'إتقان مكونات العدد 10 لتسهيل الجمع الذهني السريع بدون عدّ على الأصابع.',
          keyFormulas: ['1+9=10', '2+8=10', '3+7=10', '4+6=10', '5+5=10'],
          slides: [
            {
              heading: 'أصدقاء العدد 10',
              formula: '8 + 5 = 8 + (2 + 3) = 10 + 3 = 13',
              note: 'نكمل العدد الأكبر إلى 10 أولاً ثم نضيف الباقي لنحصل على الناتج بسرعة.',
            },
          ],
          handoutTitle: 'ملزمة أصدقاء العشرة والآحاد والعشرات',
          handoutSummary: 'تمارين مصورة على الجمع والطرح حتى 20.',
          isFreePreview: true,
        },
        {
          id: 'les-p1-ma-2',
          order: 2,
          title: 'الآحاد والعشرات والمقارنة (< ، > ، =)',
          durationMin: 26,
          videoSummary: 'فهم قيمة الرقم في منزلة الآحاد والعشرات والمقارنة بين عددين من رقمين.',
          keyFormulas: ['47 = 7 آحاد + 4 عشرات = 40 + 7'],
          slides: [
            {
              heading: 'الصيغة الممتدة للعدد',
              formula: '35 = 5 + 30',
              note: 'عند المقارنة بين عددين من رقمين ننظر أولاً إلى خانة العشرات.',
            },
          ],
          handoutTitle: 'تدريبات القيمة المكانية',
          handoutSummary: 'أسئلة رتب تصاعدياً وتنازلياً.',
          isFreePreview: false,
        },
      ],
    },

    // الصف الثاني الابتدائي
    {
      id: 'crs-p2-ar',
      title: 'اللغة العربية — الصف الثاني الابتدائي',
      subtitle: 'اللام الشمسية واللام القمرية، ضمائر المتكلم والمخاطب، وأسلوب النفي والاستفهام.',
      grade: 'p2',
      branch: 'arabic',
      monthLabel: 'تانية ابتدائي · عربي',
      priceEgp: 130,
      coverImage: ARABIC_IMG,
      totalHours: 10,
      examId: 'exam-p2-ar',
      lessons: [
        {
          id: 'les-p2-ar-1',
          order: 1,
          title: 'الفرق بين اللام الشمسية واللام القمرية (مفتوحة)',
          durationMin: 28,
          videoSummary: 'قاعدة جحا غبي فك مخه وقع، وتمييز الشدة بعد اللام الشمسية.',
          keyFormulas: ['الْقَمَرُ (تُكتب وتُنطق)', 'الشَّمْسُ (تُكتب ولا تُنطق)'],
          slides: [
            {
              heading: 'علامة اللام الشمسية واللام القمرية',
              formula: 'اللام القمرية عليها سكون (الْـ)  |  الشمسية بعدها شدة (الشَّـ)',
              note: 'الحروف القمرية مجموعة في جملة: ابغ حجك وخف عقيمه.',
            },
          ],
          handoutTitle: 'ملزمة اللام الشمسية والقمرية',
          handoutSummary: 'جدول تصنيف 30 كلمة وتدريبات القراءة.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-p2-ma',
      title: 'الرياضيات — الصف الثاني الابتدائي',
      subtitle: 'الجمع والطرح بإعادة التجميع، الأعداد حتى 999، والتمثيل البياني بالأعمدة.',
      grade: 'p2',
      branch: 'math',
      monthLabel: 'تانية ابتدائي · رياضة',
      priceEgp: 130,
      coverImage: MATH_IMG,
      totalHours: 10,
      examId: 'exam-p2-ma',
      lessons: [
        {
          id: 'les-p2-ma-1',
          order: 1,
          title: 'المئات والقيمة المكانية والجمع بإعادة التجميع',
          durationMin: 30,
          videoSummary: 'كتابة الأعداد المكونة من 3 أرقام بالصيغة الرمزية والممتدة والكلامية.',
          keyFormulas: ['348 = 300 + 40 + 8'],
          slides: [
            {
              heading: 'الجمع بإعادة التجميع',
              formula: '27 + 15 = (20 + 10) + (7 + 5) = 30 + 12 = 42',
              note: 'عندما يزيد مجموع الآحاد عن 9 نرحّل عشرة كاملة إلى خانة العشرات.',
            },
          ],
          handoutTitle: 'ملزمة المئات والجمع الذهني',
          handoutSummary: 'مسائل كلامية مبسطة على النقود والجمع.',
          isFreePreview: true,
        },
      ],
    },

    // الصف الثالث الابتدائي
    {
      id: 'crs-p3-ar',
      title: 'اللغة العربية — الصف الثالث الابتدائي',
      subtitle: 'أسلوب التعجب والنداء، أدوات الاستفهام، الأسماء الموصولة، وكتابة الفقرة.',
      grade: 'p3',
      branch: 'arabic',
      monthLabel: 'تالتة ابتدائي · عربي',
      priceEgp: 140,
      coverImage: ARABIC_IMG,
      totalHours: 11,
      examId: 'exam-p3-ar',
      lessons: [
        {
          id: 'les-p3-ar-1',
          order: 1,
          title: 'أسلوب التعجب وأسلوب النداء (حصة مجانية)',
          durationMin: 32,
          videoSummary: 'أركان أسلوب التعجب (ما + أفعل + المتعجب منه + !) واستخدامات ياء النداء.',
          keyFormulas: ['مَا أَجْمَلَ السَّمَاءَ!', 'يَا أَحْمَدُ، ذَاكِرْ دُرُوسَكَ.'],
          slides: [
            {
              heading: 'مكونات أسلوب التعجب',
              formula: 'ما (أداة التعجب) + فعل التعجب + المتعجب منه + (!)',
              note: 'نضع علامة التعجب (!) في نهاية الجملة دائماً.',
            },
          ],
          handoutTitle: 'ملزمة الأساليب والتراكيب — 3 ابتدائي',
          handoutSummary: 'تدريبات تحويل الجمل وأسئلة القراءة المتحررة.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-p3-ma',
      title: 'الرياضيات — الصف الثالث الابتدائي (جدول الضرب والكسور)',
      subtitle: 'إتقان جدول الضرب بذكاء، العلاقة بين الضرب والقسمة، المحيط والمساحة، ومقدمة الكسور.',
      grade: 'p3',
      branch: 'math',
      monthLabel: 'تالتة ابتدائي · رياضة',
      priceEgp: 150,
      coverImage: MATH_IMG,
      totalHours: 12,
      examId: 'exam-p3-ma',
      lessons: [
        {
          id: 'les-p3-ma-1',
          order: 1,
          title: 'مفهوم الضرب بالمصفوفات وخواص التوزيع (مفتوحة)',
          durationMin: 34,
          videoSummary: 'تحويل الجمع المتكرر إلى ضرب واستخدام خاصية التوزيع لحفظ الجداول الكبيرة.',
          keyFormulas: ['6 × 7 = 6 × (5 + 2) = 30 + 12 = 42'],
          slides: [
            {
              heading: 'خاصية التوزيع في الضرب',
              formula: '4 × 8 = 4 × (5 + 3) = (4×5) + (4×3) = 20 + 12 = 32',
              note: 'تُسهّل خاصية التوزيع ضرب الأعداد الكبيرة بتقسيمها إلى أجزاء مألوفة.',
            },
          ],
          handoutTitle: 'ملزمة جداول الضرب والقسمة',
          handoutSummary: 'تدريبات المصفوفات وإيجاد العامل المجهول.',
          isFreePreview: true,
        },
      ],
    },

    // الصف الرابع الابتدائي
    {
      id: 'crs-p4-ar',
      title: 'اللغة العربية — الصف الرابع الابتدائي (النحو والقراءة المتحررة)',
      subtitle: 'أقسام الكلام، الجملة الاسمية (المبتدأ والخبر)، الجملة الفعلية، والمثنى والجموع.',
      grade: 'p4',
      branch: 'arabic',
      monthLabel: 'رابعة ابتدائي · عربي',
      priceEgp: 160,
      originalPriceEgp: 200,
      coverImage: ARABIC_IMG,
      totalHours: 14,
      examId: 'exam-p4-ar',
      featured: true,
      lessons: [
        {
          id: 'les-p4-ar-1',
          order: 1,
          title: 'الجملة الاسمية: المبتدأ والخبر وعلامات الرفع (مفتوحة)',
          durationMin: 38,
          videoSummary: 'تحديد المبتدأ والخبر وإعرابهما بالضمة أو الألف للمثنى أو الواو لجمع المذكر السالم.',
          keyFormulas: ['التِّلْمِيذُ مُجْتَهِدٌ (مرفوع بالضمة)', 'التِّلْمِيذَانِ مُجْتَهِدَانِ (مرفوع بالألف)'],
          slides: [
            {
              heading: 'أركان الجملة الاسمية',
              formula: 'المبتدأ (اسم نبدأ به الجملة) + الخبر (يُتمم المعنى) = مرفوعان دائماً',
              note: 'نسأل عن الخبر بكلمة «ماله؟» لنحدده بدقة داخل الجملة.',
            },
          ],
          handoutTitle: 'ملزمة النحو التأسيسي — رابعة ابتدائي',
          handoutSummary: 'خريطة علامات الرفع وجمل إعراب نموذجية.',
          isFreePreview: true,
        },
        {
          id: 'les-p4-ar-2',
          order: 2,
          title: 'الجملة الفعلية: الفعل والفاعل وتذكير وتأنيث الفعل',
          durationMin: 40,
          videoSummary: 'التمييز بين الماضي والمضارع والأمر وإعراب الفاعل المفرد والمثنى والجمع.',
          keyFormulas: ['زَرَعَ الفَلَّاحُ الحَقْلَ  (الفلاح: فاعل مرفوع بالضمة)'],
          slides: [
            {
              heading: 'كيف نحدد الفاعل؟',
              formula: 'نسأل الفعل: مَنْ قام بالفعل؟ ← الإجابة هي الفاعل',
              note: 'الفاعل مرفوع دائماً وتختلف علامة رفعه حسب نوعه (مفرد، مثنى، جمع).',
            },
          ],
          handoutTitle: 'ملزمة الجملة الفعلية',
          handoutSummary: '25 قطعة نحوية متدرجة مع الإجابة.',
          isFreePreview: false,
        },
      ],
    },
    {
      id: 'crs-p4-ma',
      title: 'الرياضيات — الصف الرابع الابتدائي (الأعداد الكبيرة والكسور)',
      subtitle: 'الملايين والمليارات، الضرب في رقمين، القسمة المطولة، والكسور الاعتيادية.',
      grade: 'p4',
      branch: 'math',
      monthLabel: 'رابعة ابتدائي · رياضة',
      priceEgp: 170,
      originalPriceEgp: 220,
      coverImage: MATH_IMG,
      totalHours: 15,
      examId: 'exam-p4-ma',
      featured: true,
      lessons: [
        {
          id: 'les-p4-ma-1',
          order: 1,
          title: 'الكسور الاعتيادية والكسور المكافئة (حصة مجانية)',
          durationMin: 36,
          videoSummary: 'تحويل الكسر غير الحقيقي إلى عدد كسري، ومقارنة الكسور وتوحيد المقامات.',
          keyFormulas: ['1/2 = 2/4 = 3/6 = 4/8', '7/3 = 2 و 1/3'],
          slides: [
            {
              heading: 'إيجاد الكسور المكافئة',
              formula: 'a/b = (a × n) / (b × n)',
              note: 'عند ضرب البسط والمقام في نفس العدد (غير الصفر) نحصل على كسر مكافئ له نفس القيمة.',
            },
          ],
          handoutTitle: 'ملزمة الكسور الاعتيادية — 4 ابتدائي',
          handoutSummary: 'رسوم نماذج الشرائط الكسرية ومسائل مقارنة الكسور.',
          isFreePreview: true,
        },
        {
          id: 'les-p4-ma-2',
          order: 2,
          title: 'القسمة المطولة بنموذج مساحة المستطيل والخوارزمية المعيارية',
          durationMin: 42,
          videoSummary: 'خطوات القسمة المطولة (اقسم، اضرب، اطرح، نزّل الرقم التالي) والتحقق بالضرب.',
          keyFormulas: ['المقسوم = (المقسوم عليه × خارج القسمة) + الباقي'],
          slides: [
            {
              heading: 'خطوات القسمة المطولة الأربع',
              formula: '÷ قسمة  ←  × ضرب  ←  − طرح  ←  ↓ إنزال رقم',
              note: 'نكرر الخطوات حتى لا يتبقى أرقام، ونتأكد دائماً أن الباقي أصغر من المقسوم عليه.',
            },
          ],
          handoutTitle: 'بنك مسائل القسمة والضرب',
          handoutSummary: '20 مسألة كلامية من نماذج الوزارة.',
          isFreePreview: false,
        },
      ],
    },

    // الصف الخامس الابتدائي
    {
      id: 'crs-p5-ar',
      title: 'اللغة العربية — الصف الخامس الابتدائي',
      subtitle: 'المفعول به والمفعول لأجله، علامات النصب والجر، وحروف الجر والمضاف إليه.',
      grade: 'p5',
      branch: 'arabic',
      monthLabel: 'خامسة ابتدائي · عربي',
      priceEgp: 170,
      coverImage: ARABIC_IMG,
      totalHours: 14,
      examId: 'exam-p5-ar',
      lessons: [
        {
          id: 'les-p5-ar-1',
          order: 1,
          title: 'المفعول به وعلامات نصبه (مفتوحة)',
          durationMin: 36,
          videoSummary: 'إعراب المفعول به بالفتحة والياء (المثنى وجمع المذكر) والكسرة (جمع المؤنث السالم).',
          keyFormulas: ['كَافَأَ المُعَلِّمُ المُتَفَوِّقَاتِ (منصوب بالكسرة)'],
          slides: [
            {
              heading: 'علامات نصب المفعول به',
              formula: 'الفتحة (مفرد/تكسير)  |  الياء (مثنى/مذكر سالم)  |  الكسرة (مؤنث سالم)',
              note: 'انتبه: جمع المؤنث السالم يُنصب بالكسرة نيابةً عن الفتحة.',
            },
          ],
          handoutTitle: 'ملزمة المنصوبات والمضاف إليه — 5 ابتدائي',
          handoutSummary: 'جداول الإعراب وتدريبات الاختيار من متعدد.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-p5-ma',
      title: 'الرياضيات — الصف الخامس الابتدائي (الكسور العشرية والمساحات)',
      subtitle: 'جمع وطرح وضرب وقسمة الكسور العشرية، العامل المشترك الأكبر (ع.م.أ)، ومساحات الأشكال.',
      grade: 'p5',
      branch: 'math',
      monthLabel: 'خامسة ابتدائي · رياضة',
      priceEgp: 180,
      coverImage: MATH_IMG,
      totalHours: 15,
      examId: 'exam-p5-ma',
      lessons: [
        {
          id: 'les-p5-ma-1',
          order: 1,
          title: 'ضرب وقسمة الكسور العشرية في قوى العشرة (حصة مجانية)',
          durationMin: 38,
          videoSummary: 'تحريك العلامة العشرية يميناً عند الضرب ويساراً عند القسمة على 10 و100 و1000.',
          keyFormulas: ['3.45 × 10 = 34.5', '3.45 ÷ 10 = 0.345'],
          slides: [
            {
              heading: 'قاعدة تحريك العلامة العشرية',
              formula: 'الضرب في 10ⁿ ← تتحرك العلامة يميناً | القسمة على 10ⁿ ← تتحرك يساراً',
              note: 'أضف أصفاراً إذا لم تكن هناك خانات كافية لتحريك العلامة العشرية.',
            },
          ],
          handoutTitle: 'ملزمة الكسور العشرية — 5 ابتدائي',
          handoutSummary: 'تمارين على التقدير والتقريب وضرب الكسور العشرية.',
          isFreePreview: true,
        },
      ],
    },

    // الصف السادس الابتدائي
    {
      id: 'crs-p6-ar',
      title: 'اللغة العربية — الصف السادس الابتدائي (النواسخ والنحو الشامل)',
      subtitle: 'كان وأخواتها، إن وأخواتها، الأسماء الخمسة، النعت والحال، والنصوص المتحررة.',
      grade: 'p6',
      branch: 'arabic',
      monthLabel: 'سادسة ابتدائي · عربي',
      priceEgp: 190,
      originalPriceEgp: 240,
      coverImage: ARABIC_IMG,
      totalHours: 16,
      examId: 'exam-p6-ar',
      featured: true,
      lessons: [
        {
          id: 'les-p6-ar-1',
          order: 1,
          title: 'كان وأخواتها وإن وأخواتها (المقارنة الكاملة - مفتوحة)',
          durationMin: 42,
          videoSummary: 'عمل الأفعال الناسخة (ترفع المبتدأ وتنصب الخبر) وعكسها الحروف الناسخة.',
          keyFormulas: ['كَانَ الجَوُّ مُعْتَدِلاً', 'إِنَّ الجَوَّ مُعْتَدِلٌ'],
          slides: [
            {
              heading: 'الفرق الذهبي بين كان وإنّ',
              formula: 'كان: ترفع اسمها وتنصب خبرها  |  إنّ: تنصب اسمها وترفع خبرها',
              note: 'أنواع خبر كان وإنّ ثلاثة: مفرد، جملة (اسمية/فعلية)، وشبه جملة.',
            },
          ],
          handoutTitle: 'ملزمة النواسخ والأسماء الخمسة — 6 ابتدائي',
          handoutSummary: '30 سؤالاً من امتحانات المحافظات بالحل النموذجي.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-p6-ma',
      title: 'الرياضيات — الصف السادس الابتدائي (النسبة والمعادلات والحجوم)',
      subtitle: 'النسبة والمعدل، التناسب والنسبة المئوية، المعادلات والمتباينات، وحجم متوازي المستطيلات.',
      grade: 'p6',
      branch: 'math',
      monthLabel: 'سادسة ابتدائي · رياضة',
      priceEgp: 200,
      originalPriceEgp: 250,
      coverImage: MATH_IMG,
      totalHours: 16,
      examId: 'exam-p6-ma',
      featured: true,
      lessons: [
        {
          id: 'les-p6-ma-1',
          order: 1,
          title: 'النسبة والمعدل وحل المعادلات من الدرجة الأولى (حصة مجانية)',
          durationMin: 44,
          videoSummary: 'كتابة النسبة في أبسط صورة وحساب المعدل وحل معادلات الجمع والضرب.',
          keyFormulas: ['3x + 5 = 20  ⇒  3x = 15  ⇒  x = 5'],
          slides: [
            {
              heading: 'حل المعادلة بعملية عكسية متوازنة',
              formula: '2x - 4 = 10  →  2x = 14  →  x = 7',
              note: 'للتخلص من الجمع نطرح من الطرفين، وللتخلص من الضرب نقسم الطرفين على نفس العدد.',
            },
          ],
          handoutTitle: 'ملزمة النسبة والمعادلات — 6 ابتدائي',
          handoutSummary: 'مسائل كلامية شاملة على النسبة المئوية والخصم والحجوم.',
          isFreePreview: true,
        },
      ],
    },

    // قسم تأسيس رياض الأطفال (جميع المواد)
    {
      id: 'crs-kg-ar',
      title: 'تأسيس اللغة العربية لرياض الأطفال (نور البيان والقراءة)',
      subtitle: 'الحروف من الألف إلى الياء بالصوت والصورة، أشكال الحرف أول ووسط وآخر الكلمة، والدمج الصوتي.',
      grade: 'kg',
      branch: 'kg_arabic',
      monthLabel: 'رياض الأطفال · عربي',
      priceEgp: 0,
      coverImage: KG_IMG,
      totalHours: 10,
      examId: 'exam-kg-ar',
      lessons: [
        {
          id: 'les-kg-ar-1',
          order: 1,
          title: 'رحلة الحروف الهجائية بالصور والحركات (مجانية)',
          durationMin: 20,
          videoSummary: 'تعليم نطق الحروف العربية بطريقة شيقة وربط كل حرف بكلمة وصورة مألوفة للطفل.',
          keyFormulas: ['أَ (أَرْنَب) · بَ (بَطَّة) · تَ (تُفَّاح) · ثَ (ثَعْلَب)'],
          slides: [
            {
              heading: 'هيا نقرأ معاً الحروف الأولى',
              formula: 'أ — ب — ت — ث',
              note: 'ننطق الحرف بصوته الواضح ونميز موضع النقاط: الباء تحتها نقطة، والتاء فوقها نقطتان، والثاء ثلاث نقاط.',
            },
          ],
          handoutTitle: 'كراسة تلوين وكتابة الحروف — KG',
          handoutSummary: 'تتبع النقاط وتوصيل الحرف بالصورة المناسبة.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-kg-ma',
      title: 'تأسيس الحساب والرياضيات لرياض الأطفال (الأرقام والعد)',
      subtitle: 'الأرقام من 1 إلى 20، العد التصاعدي والتنازلي، أكبر وأصغر، والجمع والطرح بالأشكال.',
      grade: 'kg',
      branch: 'kg_math',
      monthLabel: 'رياض الأطفال · حساب',
      priceEgp: 110,
      coverImage: MATH_IMG,
      totalHours: 8,
      examId: 'exam-kg-ma',
      lessons: [
        {
          id: 'les-kg-ma-1',
          order: 1,
          title: 'العد من 1 إلى 10 والجمع بالأشكال (حصة مجانية)',
          durationMin: 22,
          videoSummary: 'ربط العدد بالكمية وإجراء عمليات جمع بسيطة من خلال عد المكعبات الملونة.',
          keyFormulas: ['2 + 3 = 5', '4 + 1 = 5', '5 > 3'],
          slides: [
            {
              heading: 'مفهوم الجمع: نضم المجموعتين معاً',
              formula: '🍎🍎 + 🍎🍎🍎 = 5 تفاحات',
              note: 'نبدأ بالعدد الأكبر ثم نعد تصاعدياً لنصل إلى الناتج.',
            },
          ],
          handoutTitle: 'أنشطة العد والجمع المصور — KG',
          handoutSummary: 'بطاقات عد وتلوين الأشكال الهندسية (دائرة، مربع، مثلث).',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-kg-en',
      title: 'تأسيس اللغة الإنجليزية لرياض الأطفال (Phonics A–Z)',
      subtitle: 'أصوات الحروف الإنجليزية (Jolly Phonics)، الكلمات الأساسية، الألوان والأرقام والحيوانات.',
      grade: 'kg',
      branch: 'kg_english',
      monthLabel: 'رياض الأطفال · إنجليزي',
      priceEgp: 110,
      coverImage: KG_IMG,
      totalHours: 8,
      examId: 'exam-kg-en',
      lessons: [
        {
          id: 'les-kg-en-1',
          order: 1,
          title: 'أصوات الحروف الأولى (S, A, T, P, I, N) ومحادثة الترحيب',
          durationMin: 22,
          videoSummary: 'النطق الصوتي الصحيح للحروف الإنجليزية وتكوين أول كلمات من 3 حروف (CVC).',
          keyFormulas: ['c + a + t = cat', 's + a + t = sat', 'p + i + n = pin'],
          slides: [
            {
              heading: 'دمج الأصوات لقراءة أول كلمة إنجليزية',
              formula: '/k/ + /æ/ + /t/  →  cat',
              note: 'ننطق صوت الحرف وليس اسمه عند تعليم القراءة المبكرة.',
            },
          ],
          handoutTitle: 'كراسة Phonics وأنشطة الحروف الإنجليزية',
          handoutSummary: 'تتبع الحروف الكبيرة والصغيرة (Capital & Small) مع رسومات الكلمات.',
          isFreePreview: true,
        },
      ],
    },
    {
      id: 'crs-kg-disc',
      title: 'تأسيس اكتشف والعلوم والمهارات لرياض الأطفال',
      subtitle: 'الحواس الخمس، الكائنات الحية، فصول السنة الأربعة، جسم الإنسان، والآداب والسلوكيات.',
      grade: 'kg',
      branch: 'kg_discover',
      monthLabel: 'رياض الأطفال · اكتشف ومهارات',
      priceEgp: 0,
      coverImage: HERO_IMG,
      totalHours: 6,
      examId: 'exam-kg-disc',
      lessons: [
        {
          id: 'les-kg-disc-1',
          order: 1,
          title: 'الحواس الخمس وكيف نستكشف العالم من حولنا (مجانية)',
          durationMin: 18,
          videoSummary: 'التعرف على حواس البصر والسمع والشم والتذوق واللمس ودور كل عضو في جسمنا.',
          keyFormulas: ['العين (البصر) · الأذن (السمع) · الأنف (الشم) · اللسان (التذوق) · اليد (اللمس)'],
          slides: [
            {
              heading: 'حواسنا الخمس نعمة من الله',
              formula: 'نرى بالعين · نسمع بالأذن · نشم بالأنف · نتذوق باللسان · نلمس باليد',
              note: 'نحافظ على نظافة حواسنا ولا نقترب من الشاشات أو الأصوات العالية.',
            },
          ],
          handoutTitle: 'أنشطة اكتشف والحواس الخمس',
          handoutSummary: 'نشاط توصيل العضو بالحاسة والمحافظة على الصحة.',
          isFreePreview: true,
        },
      ],
    },
  ];

  const exams: Exam[] = [
    {
      id: 'exam-p1-ar',
      courseId: 'crs-p1-ar',
      title: 'اختبار الحركات والمدود — أولى ابتدائي',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qp1a-1',
          prompt: 'أي من الكلمات التالية تحتوي على مد بالألف؟',
          options: ['أَسَد', 'قَال', 'قَلَم', 'بَيْت'],
          correctIndex: 1,
          explanation: 'كلمة «قَال» بها ألف مد ساكنة وقبلها حرف القاف مفتوح.',
        },
        {
          id: 'qp1a-2',
          prompt: 'الحرف الممدود في كلمة «سَعِيد» هو:',
          options: ['السين', 'العين', 'الياء', 'الدال'],
          correctIndex: 1,
          explanation: 'الحرف الممدود يسبق حرف المد مباشرة، والياء تسبقها العين المكسورة.',
        },
      ],
    },
    {
      id: 'exam-p1-ma',
      courseId: 'crs-p1-ma',
      title: 'اختبار الأعداد والجمع — أولى ابتدائي',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qp1m-1',
          prompt: 'ما العدد الذي يساوي 6 آحاد + 3 عشرات؟',
          options: ['63', '36', '9', '30'],
          correctIndex: 1,
          explanation: '6 في الآحاد و3 في العشرات تعطينا العدد 36.',
        },
        {
          id: 'qp1m-2',
          prompt: 'ناتج جمع 8 + 7 يساوي:',
          options: ['14', '15', '16', '13'],
          correctIndex: 1,
          explanation: '8 + 2 = 10 ويتبقى 5، إذن 10 + 5 = 15.',
        },
      ],
    },
    {
      id: 'exam-p2-ar',
      courseId: 'crs-p2-ar',
      title: 'اختبار اللام الشمسية والقمرية — تانية ابتدائي',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qp2a-1',
          prompt: 'أي كلمة تبدأ بلام شمسية؟',
          options: ['القمر', 'الكتاب', 'الشمس', 'المدرسة'],
          correctIndex: 2,
          explanation: 'كلمة «الشمس» تكتب اللام ولا تنطق ويأتي بعدها حرف الشين مشدداً.',
        },
      ],
    },
    {
      id: 'exam-p2-ma',
      courseId: 'crs-p2-ma',
      title: 'اختبار المئات والجمع — تانية ابتدائي',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qp2m-1',
          prompt: 'قيمة الرقم 4 في العدد 425 هي:',
          options: ['4', '40', '400', '4000'],
          correctIndex: 2,
          explanation: 'الرقم 4 يقع في خانة المئات، فتكون قيمته 400.',
        },
      ],
    },
    {
      id: 'exam-p3-ar',
      courseId: 'crs-p3-ar',
      title: 'اختبار الأساليب — تالتة ابتدائي',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qp3a-1',
          prompt: '«ما أروع نهر النيل!» — نوع هذا الأسلوب هو:',
          options: ['أسلوب نداء', 'أسلوب تعجب', 'أسلوب نفي', 'أسلوب أمر'],
          correctIndex: 1,
          explanation: 'بدأ بـ «ما» التعجبية وفعل التعجب «أروع» وانتهى بعلامة التعجب (!).',
        },
      ],
    },
    {
      id: 'exam-p3-ma',
      courseId: 'crs-p3-ma',
      title: 'اختبار الضرب والكسور — تالتة ابتدائي',
      durationMin: 12,
      passingScore: 50,
      questions: [
        {
          id: 'qp3m-1',
          prompt: 'ناتج ضرب 7 × 8 يساوي:',
          options: ['54', '56', '48', '64'],
          correctIndex: 1,
          explanation: '7 × 8 = 56.',
        },
        {
          id: 'qp3m-2',
          prompt: 'إذا قُسّمت فطيرة إلى 4 أجزاء متساوية وأكلنا جزءاً واحداً، فما الكسر الدال على ما أكلناه؟',
          options: ['1/2', '1/3', '1/4', '3/4'],
          correctIndex: 2,
          explanation: 'جزء واحد من 4 أجزاء متساوية يساوي ربعاً (1/4).',
        },
      ],
    },
    {
      id: 'exam-p4-ar',
      courseId: 'crs-p4-ar',
      title: 'اختبار الجملة الاسمية والفعلية — رابعة ابتدائي',
      durationMin: 15,
      passingScore: 50,
      questions: [
        {
          id: 'qp4a-1',
          prompt: 'في جملة «السماءُ صافيةٌ»، إعراب كلمة «صافيةٌ» هو:',
          options: ['مبتدأ مرفوع', 'خبر مرفوع بالضمة', 'فاعل مرفوع', 'اسم مجرور'],
          correctIndex: 1,
          explanation: 'أتمت معنى الجملة الاسمية فتُعرب خبراً مرفوعاً وعلامة رفعه الضمة.',
        },
        {
          id: 'qp4a-2',
          prompt: 'علامة رفع الفاعل في جملة «فازَ اللاعبانِ» هي:',
          options: ['الضمة', 'الألف', 'الواو', 'الفتحة'],
          correctIndex: 1,
          explanation: '«اللاعبان» مثنى، والمثنى يُرفع وعلامة رفعه الألف.',
        },
      ],
    },
    {
      id: 'exam-p4-ma',
      courseId: 'crs-p4-ma',
      title: 'اختبار الكسور والقسمة — رابعة ابتدائي',
      durationMin: 15,
      passingScore: 50,
      questions: [
        {
          id: 'qp4m-1',
          prompt: 'أي كسر يكافئ الكسر 2/3؟',
          options: ['4/9', '4/6', '3/2', '6/8'],
          correctIndex: 1,
          explanation: 'بضرب البسط والمقام في 2 نحصل على (2×2)/(3×2) = 4/6.',
        },
        {
          id: 'qp4m-2',
          prompt: 'ناتج قسمة 84 ÷ 4 يساوي:',
          options: ['12', '21', '24', '14'],
          correctIndex: 1,
          explanation: '8 عشرات ÷ 4 = 2 عشرات، و4 آحاد ÷ 4 = 1، فالناتج 21.',
        },
      ],
    },
    {
      id: 'exam-p5-ar',
      courseId: 'crs-p5-ar',
      title: 'اختبار المفعول به — خامسة ابتدائي',
      durationMin: 12,
      passingScore: 50,
      questions: [
        {
          id: 'qp5a-1',
          prompt: 'علامة نصب المفعول به في جملة «شاهدَ التلميذُ الأهراماتِ» هي:',
          options: ['الفتحة', 'الكسرة', 'الياء', 'الألف'],
          correctIndex: 1,
          explanation: '«الأهرامات» جمع مؤنث سالم، ويُنصب وعلامة نصبه الكسرة.',
        },
      ],
    },
    {
      id: 'exam-p5-ma',
      courseId: 'crs-p5-ma',
      title: 'اختبار الكسور العشرية — خامسة ابتدائي',
      durationMin: 12,
      passingScore: 50,
      questions: [
        {
          id: 'qp5m-1',
          prompt: 'ناتج 4.25 × 10 يساوي:',
          options: ['0.425', '42.5', '425', '4.250'],
          correctIndex: 1,
          explanation: 'عند الضرب في 10 تتحرك العلامة العشرية خانة واحدة جهة اليمين فتصبح 42.5.',
        },
      ],
    },
    {
      id: 'exam-p6-ar',
      courseId: 'crs-p6-ar',
      title: 'اختبار كان وإنّ وأخواتها — سادسة ابتدائي',
      durationMin: 15,
      passingScore: 50,
      questions: [
        {
          id: 'qp6a-1',
          prompt: 'اختر الجملة الصحيحة بعد دخول «إنّ» على «الطالبُ مجتهدٌ»:',
          options: [
            'إنَّ الطالبُ مجتهدٌ',
            'إنَّ الطالبَ مجتهدٌ',
            'إنَّ الطالبَ مجتهداً',
            'إنَّ الطالبُ مجتهداً',
          ],
          correctIndex: 1,
          explanation: 'إنّ تنصب الاسم (الطالبَ) وترفع الخبر (مجتهدٌ).',
        },
      ],
    },
    {
      id: 'exam-p6-ma',
      courseId: 'crs-p6-ma',
      title: 'اختبار النسبة والمعادلات — سادسة ابتدائي',
      durationMin: 15,
      passingScore: 50,
      questions: [
        {
          id: 'qp6m-1',
          prompt: 'النسبة 12 : 18 في أبسط صورة هي:',
          options: ['6 : 9', '2 : 3', '3 : 4', '4 : 6'],
          correctIndex: 1,
          explanation: 'بقسمة حدي النسبة على العامل المشترك الأكبر (6) تصبح 2 : 3.',
        },
        {
          id: 'qp6m-2',
          prompt: 'إذا كان 3x + 2 = 17، فما قيمة x؟',
          options: ['3', '5', '6', '15'],
          correctIndex: 1,
          explanation: '3x = 17 - 2 = 15، وبقسمة الطرفين على 3 تصبح x = 5.',
        },
      ],
    },
    {
      id: 'exam-kg-ar',
      courseId: 'crs-kg-ar',
      title: 'نشاط تقييم الحروف — رياض الأطفال',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qka-1',
          prompt: 'ما الحرف الذي تبدأ به كلمة «تُفَّاح»؟',
          options: ['ب', 'ت', 'ث', 'ج'],
          correctIndex: 1,
          explanation: 'كلمة تفاح تبدأ بحرف التاء وفوقه نقطتان.',
        },
      ],
    },
    {
      id: 'exam-kg-ma',
      courseId: 'crs-kg-ma',
      title: 'نشاط تقييم العد والجمع — رياض الأطفال',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qkm-1',
          prompt: 'كم عدد التفاحات في 3 تفاحات + 2 تفاحة؟',
          options: ['4', '5', '6', '3'],
          correctIndex: 1,
          explanation: '3 + 2 = 5 تفاحات.',
        },
      ],
    },
    {
      id: 'exam-kg-en',
      courseId: 'crs-kg-en',
      title: 'نشاط تقييم Phonics — رياض الأطفال',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qke-1',
          prompt: 'أي كلمة تبدأ بحرف C مثل Cat؟',
          options: ['Apple', 'Ball', 'Car', 'Dog'],
          correctIndex: 2,
          explanation: 'كلمة Car تبدأ بحرف C.',
        },
      ],
    },
    {
      id: 'exam-kg-disc',
      courseId: 'crs-kg-disc',
      title: 'نشاط الحواس الخمس — رياض الأطفال',
      durationMin: 10,
      passingScore: 50,
      questions: [
        {
          id: 'qkd-1',
          prompt: 'بأي عضو نسمع الأصوات الجميلة؟',
          options: ['العين', 'الأذن', 'الأنف', 'اليد'],
          correctIndex: 1,
          explanation: 'نسمع الأصوات بواسطة الأذن.',
        },
      ],
    },
  ];

  const students: Student[] = [
    {
      id: 'stu-demo',
      name: 'يوسف طارق محمود',
      phone: '01099887766',
      parentPhone: '01001122334',
      governorate: 'القاهرة',
      grade: 'p4',
      walletBalance: 350,
      enrolledCourseIds: ['crs-p1-ar', 'crs-p4-ar', 'crs-kg-ar', 'crs-kg-disc'],
      completedLessonIds: ['les-p1-ar-1', 'les-p4-ar-1'],
      totalWatchMinutes: 120,
      points: 860,
      createdAt: daysAgo(15),
    },
    {
      id: 'stu-2',
      name: 'مريم حسام الدين',
      phone: '01122334455',
      parentPhone: '01155443322',
      governorate: 'الجيزة',
      grade: 'p6',
      walletBalance: 180,
      enrolledCourseIds: ['crs-p6-ar', 'crs-p6-ma', 'crs-p1-ar'],
      completedLessonIds: ['les-p6-ar-1', 'les-p6-ma-1'],
      totalWatchMinutes: 210,
      points: 1320,
      createdAt: daysAgo(20),
    },
    {
      id: 'stu-3',
      name: 'آدم عمر خالد',
      phone: '01233445566',
      parentPhone: '01299887711',
      governorate: 'الإسكندرية',
      grade: 'kg',
      walletBalance: 220,
      enrolledCourseIds: ['crs-kg-ar', 'crs-kg-ma', 'crs-kg-en', 'crs-kg-disc'],
      completedLessonIds: ['les-kg-ar-1', 'les-kg-ma-1', 'les-kg-en-1'],
      totalWatchMinutes: 150,
      points: 1140,
      createdAt: daysAgo(10),
    },
    {
      id: 'stu-4',
      name: 'لينا محمد إبراهيم',
      phone: '01544332211',
      parentPhone: '01511223344',
      governorate: 'الدقهلية',
      grade: 'p3',
      walletBalance: 90,
      enrolledCourseIds: ['crs-p3-ar', 'crs-p3-ma'],
      completedLessonIds: ['les-p3-ar-1', 'les-p3-ma-1'],
      totalWatchMinutes: 135,
      points: 980,
      createdAt: daysAgo(9),
    },
  ];

  const activationCodes: ActivationCode[] = [
    {
      code: 'QEMA-P4-MATH',
      courseId: 'crs-p4-ma',
      status: 'active',
      createdAt: daysAgo(5),
    },
    {
      code: 'QEMA-P6-ARABIC',
      courseId: 'crs-p6-ar',
      status: 'active',
      createdAt: daysAgo(4),
    },
    {
      code: 'QEMA-KG-MATH',
      courseId: 'crs-kg-ma',
      status: 'active',
      createdAt: daysAgo(3),
    },
    {
      code: 'QEMA-VIP-2026',
      courseId: 'ALL',
      status: 'active',
      createdAt: daysAgo(2),
    },
    {
      code: 'QEMA-USED-201',
      courseId: 'crs-p6-ma',
      status: 'used',
      createdAt: daysAgo(8),
      usedByStudentId: 'stu-2',
      usedByStudentName: 'مريم حسام الدين',
      usedAt: daysAgo(7),
    },
  ];

  const walletRequests: WalletRequest[] = [
    {
      id: 'wr-101',
      studentId: 'stu-demo',
      studentName: 'يوسف طارق محمود',
      studentPhone: '01099887766',
      amountEgp: 200,
      method: 'vodafone_cash',
      referenceNumber: 'VF-9948210',
      status: 'pending',
      createdAt: hoursAgo(2),
    },
    {
      id: 'wr-102',
      studentId: 'stu-3',
      studentName: 'آدم عمر خالد',
      studentPhone: '01233445566',
      amountEgp: 300,
      method: 'instapay',
      referenceNumber: 'IP-7721904',
      status: 'approved',
      createdAt: daysAgo(2),
    },
  ];

  const examAttempts: ExamAttempt[] = [
    {
      id: 'att-1',
      examId: 'exam-p6-ma',
      courseId: 'crs-p6-ma',
      studentId: 'stu-2',
      studentName: 'مريم حسام الدين',
      score: 2,
      total: 2,
      percentage: 100,
      passed: true,
      answers: [1, 1],
      submittedAt: daysAgo(3),
    },
    {
      id: 'att-2',
      examId: 'exam-p4-ar',
      courseId: 'crs-p4-ar',
      studentId: 'stu-demo',
      studentName: 'يوسف طارق محمود',
      score: 2,
      total: 2,
      percentage: 100,
      passed: true,
      answers: [1, 1],
      submittedAt: daysAgo(2),
    },
  ];

  const announcements: Announcement[] = [
    {
      id: 'ann-1',
      title: 'انطلاق باقة تأسيس رياض الأطفال (KG1 & KG2) في جميع المواد',
      body: 'أصبح الآن بإمكان أولياء الأمور متابعة دروس تأسيس اللغة العربية (نور البيان)، الحساب، الإنجليزي Phonics، ومادة اكتشف من صفحة رياض الأطفال مباشرة.',
      grade: 'kg',
      createdAt: daysAgo(2),
    },
    {
      id: 'ann-2',
      title: 'دروس العربي والرياضيات متاحة الآن من أولى إلى سادسة ابتدائي',
      body: 'كل صف دراسي يضم كورس اللغة العربية وكورس الرياضيات مع ملازم PDF للطباعة واختبارات إلكترونية مصححة فورياً.',
      grade: 'all',
      createdAt: daysAgo(1),
    },
  ];

  const defaultPassHash = hashPassword('123456');
  const credentials: CredentialRecord[] = students.map((s) => ({
    id: s.id,
    phone: s.phone,
    passwordHash: defaultPassHash,
  }));

  const fawryOrders: FawryOrder[] = [];
  const certificates: Certificate[] = [];
  const attendances: LessonAttendance[] = [];
  const chatMessages: ChatMessage[] = [
    {
      id: 'msg-welcome-1',
      threadId: 'student:stu-demo',
      senderRole: 'teacher',
      senderName: 'الأستاذة نجلاء فتحي',
      senderPhone: '01029121467',
      text: 'أهلاً بكم في المحادثة المباشرة لمنصة الأستاذة نجلاء فتحي! يمكنك كتابة استفسارك هنا أو التواصل هاتفياً وواتساب على 01029121467.',
      createdAt: hoursAgo(3),
    },
  ];
  const monthlyCourses = applyMonthlySyllabusToCourses(courses);
  const lectureSchedules = createDefaultLectureSchedules(monthlyCourses, profile.teacherName);
  const lessonReviews = createDefaultLessonReviews(monthlyCourses, students);

  const payoutSettings: TeacherPayoutSettings = {
    autoTransferEnabled: true,
    destinationMethod: 'vodafone_cash',
    destinationPhone: profile.hotline || '01029121467',
    destinationLabel: 'محفظة الأستاذة نجلاء فتحي',
  };

  const teacherTransactions: TeacherWalletTransaction[] = [
    {
      id: 'tx-seed-out-1',
      type: 'auto_payout',
      amountEgp: 300,
      sourceMethod: 'instapay',
      studentId: 'stu-3',
      studentName: 'آدم عمر خالد',
      destinationPhone: '01029121467',
      referenceNumber: 'PAYOUT-7721904',
      status: 'transferred',
      note: 'تحويل تلقائي فوري عبر فودافون كاش إلى 01029121467',
      createdAt: daysAgo(2),
    },
    {
      id: 'tx-seed-in-1',
      type: 'student_payment',
      amountEgp: 300,
      sourceMethod: 'instapay',
      studentId: 'stu-3',
      studentName: 'آدم عمر خالد',
      referenceNumber: 'IP-7721904',
      status: 'credited',
      note: 'سداد شحن محفظة الطالب (آدم عمر خالد)',
      createdAt: daysAgo(2),
    },
  ];

  const initialStore: PersistedAcademyStore = {
    profile,
    courses: monthlyCourses,
    exams,
    students,
    activationCodes,
    walletRequests,
    examAttempts,
    announcements,
    fawryOrders,
    fawryStatus: getFawryStatus(),
    certificates,
    attendances,
    chatMessages,
    lectureSchedules,
    lessonReviews,
    teacherWalletBalance: 0,
    teacherTotalCollectedEgp: 300,
    teacherTotalTransferredEgp: 300,
    payoutSettings,
    teacherTransactions,
    credentials,
    sessions: [],
  };
  syncAllEligibleCertificates(initialStore);
  return initialStore;
}

function getPublicSnapshot(store: PersistedAcademyStore): AcademySnapshot {
  return {
    profile: store.profile,
    courses: store.courses,
    exams: store.exams,
    students: store.students,
    activationCodes: store.activationCodes,
    walletRequests: store.walletRequests,
    examAttempts: store.examAttempts,
    announcements: store.announcements,
    fawryOrders: store.fawryOrders,
    fawryStatus: getFawryStatus(),
    certificates: store.certificates,
    attendances: store.attendances,
    chatMessages: store.chatMessages,
    lectureSchedules: store.lectureSchedules,
    lessonReviews: store.lessonReviews,
    teacherWalletBalance: store.teacherWalletBalance,
    teacherTotalCollectedEgp: store.teacherTotalCollectedEgp,
    teacherTotalTransferredEgp: store.teacherTotalTransferredEgp,
    payoutSettings: store.payoutSettings,
    teacherTransactions: store.teacherTransactions,
  };
}

function normalizeStore(raw: unknown): PersistedAcademyStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as PersistedAcademyStore;
  if (!Array.isArray(parsed.courses) || !Array.isArray(parsed.students)) {
    return null;
  }
  if (!Array.isArray(parsed.credentials)) {
    const defaultHash = hashPassword('123456');
    parsed.credentials = parsed.students.map((s) => ({
      id: s.id,
      phone: normalizePhone(s.phone),
      passwordHash: defaultHash,
    }));
  }
  if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
  if (!Array.isArray(parsed.activationCodes)) parsed.activationCodes = [];
  if (!Array.isArray(parsed.walletRequests)) parsed.walletRequests = [];
  if (!Array.isArray(parsed.examAttempts)) parsed.examAttempts = [];
  if (!Array.isArray(parsed.announcements)) parsed.announcements = [];
  if (!Array.isArray(parsed.fawryOrders)) parsed.fawryOrders = [];
  if (!Array.isArray(parsed.certificates)) parsed.certificates = [];
  if (!Array.isArray(parsed.attendances)) parsed.attendances = [];
  if (!Array.isArray(parsed.chatMessages)) parsed.chatMessages = [];
  if (parsed.profile && (!parsed.profile.hotline || parsed.profile.hotline === '0100-482-9910')) {
    parsed.profile.hotline = '01029121467';
  }
  parsed.courses = applyMonthlySyllabusToCourses(parsed.courses);
  if (!Array.isArray(parsed.lectureSchedules) || parsed.lectureSchedules.length === 0) {
    parsed.lectureSchedules = createDefaultLectureSchedules(
      parsed.courses,
      parsed.profile?.teacherName || 'الأستاذة نجلاء فتحي'
    );
  }
  if (!Array.isArray(parsed.lessonReviews)) {
    parsed.lessonReviews = createDefaultLessonReviews(parsed.courses, parsed.students);
  }
  if (!parsed.payoutSettings || typeof parsed.payoutSettings !== 'object') {
    parsed.payoutSettings = {
      autoTransferEnabled: true,
      destinationMethod: 'vodafone_cash',
      destinationPhone: parsed.profile?.hotline || '01029121467',
      destinationLabel: 'محفظة الأستاذة نجلاء فتحي',
    };
  }
  if (!Array.isArray(parsed.teacherTransactions)) {
    parsed.teacherTransactions = [];
  }
  if (typeof parsed.teacherWalletBalance !== 'number' || !Number.isFinite(parsed.teacherWalletBalance)) {
    parsed.teacherWalletBalance = 0;
  }
  if (typeof parsed.teacherTotalCollectedEgp !== 'number' || !Number.isFinite(parsed.teacherTotalCollectedEgp)) {
    parsed.teacherTotalCollectedEgp = 0;
  }
  if (typeof parsed.teacherTotalTransferredEgp !== 'number' || !Number.isFinite(parsed.teacherTotalTransferredEgp)) {
    parsed.teacherTotalTransferredEgp = 0;
  }
  parsed.fawryStatus = getFawryStatus();
  syncAllEligibleCertificates(parsed);
  return parsed;
}

async function startServer() {
  const storeAdapter = createCloudStore<PersistedAcademyStore>({
    dataDir: DATA_DIR,
    localFilePath: STORE_PATH,
    createInitial: createInitialStore,
    normalize: normalizeStore,
  });

  let state: PersistedAcademyStore = await storeAdapter.load();
  const saveStore = (data: PersistedAcademyStore, opts?: { immediate?: boolean }) => {
    storeAdapter.save(data, opts);
  };

  const handleShutdown = async () => {
    await storeAdapter.flush();
    process.exit(0);
  };
  process.once('SIGTERM', () => void handleShutdown());
  process.once('SIGINT', () => void handleShutdown());

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'qema-primary-kg-academy',
      storage: storeAdapter.mode,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get('/api/state', (_req, res) => {
    res.json(getPublicSnapshot(state));
  });

  app.post('/api/auth/register', (req, res) => {
    const body = req.body as {
      name?: string;
      phone?: string;
      parentPhone?: string;
      governorate?: string;
      grade?: GradeLevel;
      password?: string;
    };

    const name = String(body.name || '').trim();
    const phone = normalizePhone(body.phone || '');
    const parentPhone = normalizePhone(body.parentPhone || '');
    const governorate = String(body.governorate || 'القاهرة').trim();
    const validGrades: GradeLevel[] = ['kg', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const grade: GradeLevel = validGrades.includes(body.grade as GradeLevel)
      ? (body.grade as GradeLevel)
      : 'p4';
    const password = String(body.password || '');

    if (name.length < 2) {
      res.status(400).json({ error: 'يرجى إدخال اسم الطالب كاملاً' });
      return;
    }
    if (phone.length < 10) {
      res.status(400).json({ error: 'يرجى إدخال رقم موبايل صحيح' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 6 أحرف أو أرقام' });
      return;
    }
    if (state.credentials.some((c) => c.phone === phone)) {
      res.status(409).json({ error: 'رقم الموبايل مسجل بالفعل، يمكنك تسجيل الدخول مباشرة' });
      return;
    }

    const freeCourses = state.courses.filter((c) => c.priceEgp === 0).map((c) => c.id);
    const newStudent: Student = {
      id: `stu-${Date.now()}`,
      name,
      phone,
      parentPhone: parentPhone || phone,
      governorate,
      grade,
      walletBalance: 100,
      enrolledCourseIds: freeCourses,
      completedLessonIds: [],
      totalWatchMinutes: 0,
      points: 100,
      createdAt: new Date().toISOString(),
    };

    const token = crypto.randomBytes(24).toString('hex');
    state.students.unshift(newStudent);
    state.credentials.push({
      id: newStudent.id,
      phone,
      passwordHash: hashPassword(password),
    });
    state.sessions.push({
      token,
      studentId: newStudent.id,
      createdAt: new Date().toISOString(),
    });
    saveStore(state);

    res.status(201).json({
      token,
      student: newStudent,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const body = req.body as { phone?: string; password?: string };
    const phone = normalizePhone(body.phone || '');
    const password = String(body.password || '');

    const cred = state.credentials.find((c) => c.phone === phone);
    if (!cred || !verifyPassword(password, cred.passwordHash)) {
      res.status(401).json({ error: 'رقم الموبايل أو كلمة المرور غير صحيحة' });
      return;
    }

    const student = state.students.find((s) => s.id === cred.id);
    if (!student) {
      res.status(404).json({ error: 'حساب الطالب غير موجود' });
      return;
    }

    const token = crypto.randomBytes(24).toString('hex');
    state.sessions.push({
      token,
      studentId: student.id,
      createdAt: new Date().toISOString(),
    });
    saveStore(state);
    res.json({ token, student });
  });

  app.get('/api/auth/me', (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const session = state.sessions.find((s) => s.token === token);
    if (!session) {
      res.status(401).json({ error: 'الجلسة منتهية' });
      return;
    }
    const student = state.students.find((s) => s.id === session.studentId);
    if (!student) {
      res.status(404).json({ error: 'الحساب غير موجود' });
      return;
    }
    res.json({ student });
  });

  app.post('/api/auth/logout', (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      state.sessions = state.sessions.filter((s) => s.token !== token);
      saveStore(state);
    }
    res.json({ ok: true });
  });

  app.post('/api/courses/:courseId/enroll-wallet', (req, res) => {
    const { studentId } = req.body as { studentId?: string };
    const student = state.students.find((s) => s.id === studentId);
    const course = state.courses.find((c) => c.id === req.params.courseId);

    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول بحساب الطالب أو ولي الأمر أولاً' });
      return;
    }
    if (!course) {
      res.status(404).json({ error: 'الكورس غير موجود' });
      return;
    }
    if (student.enrolledCourseIds.includes(course.id)) {
      res.json({ student, snapshot: getPublicSnapshot(state), message: 'أنت مشترك بالفعل في هذا الكورس' });
      return;
    }
    if (student.walletBalance < course.priceEgp) {
      res.status(400).json({
        error: `رصيد المحفظة غير كافٍ (رصيدك ${student.walletBalance} ج.م وسعر الكورس ${course.priceEgp} ج.م)`,
      });
      return;
    }

    student.walletBalance = Number((student.walletBalance - course.priceEgp).toFixed(2));
    student.enrolledCourseIds.push(course.id);
    student.points += 50;

    if (course.priceEgp > 0) {
      recordPaymentToTeacherWallet(state, {
        amountEgp: course.priceEgp,
        sourceMethod: 'student_wallet',
        student,
        course,
        referenceNumber: `WLT-${Date.now().toString().slice(-6)}`,
        note: `اشتراك كورس «${course.title}» من محفظة الطالب (${student.name})`,
      });
    }

    saveStore(state);

    res.json({
      student,
      snapshot: getPublicSnapshot(state),
      message: `تم الاشتراك بنجاح في ${course.title}`,
    });
  });

  app.post('/api/codes/redeem', (req, res) => {
    const body = req.body as { studentId?: string; code?: string; targetCourseId?: string };
    const student = state.students.find((s) => s.id === body.studentId);
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً لتفعيل الكود على حسابك' });
      return;
    }

    const cleanCode = String(body.code || '').trim().toUpperCase();
    if (!cleanCode) {
      res.status(400).json({ error: 'يرجى إدخال كود التفعيل' });
      return;
    }

    const codeObj = state.activationCodes.find((c) => c.code.toUpperCase() === cleanCode);
    if (!codeObj) {
      res.status(404).json({ error: 'كود التفعيل غير صحيح، تأكد من كتابة الحروف والأرقام بدقة' });
      return;
    }
    if (codeObj.status === 'used') {
      res.status(409).json({
        error: `هذا الكود تم استخدامه مسبقاً بواسطة ${codeObj.usedByStudentName || 'طالب آخر'}`,
      });
      return;
    }

    const unlockedTitles: string[] = [];
    if (codeObj.courseId === 'ALL') {
      if (body.targetCourseId) {
        const target = state.courses.find((c) => c.id === body.targetCourseId);
        if (target && !student.enrolledCourseIds.includes(target.id)) {
          student.enrolledCourseIds.push(target.id);
          unlockedTitles.push(target.title);
        }
      } else {
        state.courses.forEach((c) => {
          if (!student.enrolledCourseIds.includes(c.id)) {
            student.enrolledCourseIds.push(c.id);
            unlockedTitles.push(c.title);
          }
        });
      }
    } else {
      const target = state.courses.find((c) => c.id === codeObj.courseId);
      if (!target) {
        res.status(404).json({ error: 'الكورس المرتبط بهذا الكود غير متاح' });
        return;
      }
      if (!student.enrolledCourseIds.includes(target.id)) {
        student.enrolledCourseIds.push(target.id);
      }
      unlockedTitles.push(target.title);
    }

    codeObj.status = 'used';
    codeObj.usedByStudentId = student.id;
    codeObj.usedByStudentName = student.name;
    codeObj.usedAt = new Date().toISOString();
    student.points += 60;
    saveStore(state);

    res.json({
      student,
      snapshot: getPublicSnapshot(state),
      message:
        unlockedTitles.length > 0
          ? `تم تفعيل الكود بنجاح! تم فتح: ${unlockedTitles.join('، ')}`
          : 'تم تفعيل الكود على حسابك بنجاح',
    });
  });

  app.post('/api/wallet/topup-request', (req, res) => {
    const body = req.body as {
      studentId?: string;
      amountEgp?: number;
      method?: TopupMethod;
      referenceNumber?: string;
    };
    const student = state.students.find((s) => s.id === body.studentId);
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً' });
      return;
    }
    const amountEgp = Number(body.amountEgp || 0);
    if (!Number.isFinite(amountEgp) || amountEgp < 50 || amountEgp > 5000) {
      res.status(400).json({ error: 'مبلغ الشحن يجب أن يكون بين 50 و 5000 جنيه مصري' });
      return;
    }
    const ref = String(body.referenceNumber || '').trim();
    if (ref.length < 4) {
      res.status(400).json({ error: 'يرجى إدخال رقم العملية أو رقم المحول منه' });
      return;
    }
    const method: TopupMethod =
      body.method === 'instapay' || body.method === 'fawry' ? body.method : 'vodafone_cash';

    const newReq: WalletRequest = {
      id: `wr-${Date.now()}`,
      studentId: student.id,
      studentName: student.name,
      studentPhone: student.phone,
      amountEgp: Math.round(amountEgp),
      method,
      referenceNumber: ref,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    state.walletRequests.unshift(newReq);
    saveStore(state);

    res.status(201).json({
      request: newReq,
      snapshot: getPublicSnapshot(state),
    });
  });

  const getSessionStudent = (req: express.Request): Student | null => {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const session = state.sessions.find((s) => s.token === token);
    if (!session) return null;
    return state.students.find((s) => s.id === session.studentId) || null;
  };

  const isStudentCourseUnlocked = (course: Course, student: Student | null): boolean => {
    if (course.priceEgp === 0) return true;
    return Boolean(student && student.enrolledCourseIds.includes(course.id));
  };

  const fulfillFawryOrder = (order: FawryOrder): Student | null => {
    if (order.status === 'PAID') {
      return state.students.find((s) => s.id === order.studentId) || null;
    }
    order.status = 'PAID';
    order.paidAt = new Date().toISOString();

    const student = state.students.find((s) => s.id === order.studentId) || null;
    const targetCourse = order.courseId
      ? state.courses.find((c) => c.id === order.courseId) || null
      : null;

    if (student) {
      if (order.purpose === 'course' && order.courseId) {
        if (!student.enrolledCourseIds.includes(order.courseId)) {
          student.enrolledCourseIds.push(order.courseId);
          student.points += 80;
        }
      } else if (order.purpose === 'wallet') {
        student.walletBalance = Number((student.walletBalance + order.amountEgp).toFixed(2));
        student.points += 25;
      }
    }

    recordPaymentToTeacherWallet(state, {
      amountEgp: order.amountEgp,
      sourceMethod: 'fawry',
      student,
      course: targetCourse,
      referenceNumber: order.referenceNumber,
      note:
        order.purpose === 'course'
          ? `دفع فوري باي لاشتراك كورس «${targetCourse?.title || order.courseTitle || order.courseId}»`
          : `شحن محفظة الطالب عبر فوري باي (${order.studentName})`,
    });

    saveStore(state, { immediate: true });
    return student;
  };

  app.post('/api/payments/fawry/charge', async (req, res) => {
    const authedStudent = getSessionStudent(req);
    const body = req.body as {
      studentId?: string;
      purpose?: 'course' | 'wallet';
      courseId?: string;
      amountEgp?: number;
    };

    const student = authedStudent || state.students.find((s) => s.id === body.studentId) || null;
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول بحساب الطالب أولاً لإصدار كود دفع فوري' });
      return;
    }

    const purpose: 'course' | 'wallet' = body.purpose === 'course' ? 'course' : 'wallet';
    let amountEgp = 0;
    let course: Course | undefined;

    if (purpose === 'course') {
      course = state.courses.find((c) => c.id === body.courseId);
      if (!course) {
        res.status(404).json({ error: 'الكورس المطلوب غير موجود' });
        return;
      }
      if (course.priceEgp <= 0 || student.enrolledCourseIds.includes(course.id)) {
        res.status(400).json({ error: 'هذا الكورس مفعل بالفعل على حسابك' });
        return;
      }
      amountEgp = course.priceEgp;
    } else {
      const requestedAmount = Number(body.amountEgp || 0);
      if (!Number.isFinite(requestedAmount) || requestedAmount < 50 || requestedAmount > 5000) {
        res.status(400).json({ error: 'مبلغ الشحن عبر فوري يجب أن يكون بين 50 و 5000 ج.م' });
        return;
      }
      amountEgp = Math.round(requestedAmount);
    }

    const cfg = getFawryConfig();
    const merchantRefNum = `FWR-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
    let referenceNumber = '';
    let orderMode: 'live' | 'sandbox' = 'sandbox';

    if (cfg.configured) {
      try {
        const amountFormatted = amountEgp.toFixed(2);
        const signatureInput = `${cfg.merchantCode}${merchantRefNum}${student.id}PAYATFAWRY${amountFormatted}${cfg.securityKey}`;
        const signature = sha256Hex(signatureInput);
        const fawryPayload = {
          merchantCode: cfg.merchantCode,
          merchantRefNum,
          customerProfileId: student.id,
          customerName: student.name,
          customerMobile: student.phone,
          paymentMethod: 'PAYATFAWRY',
          amount: amountFormatted,
          currencyCode: 'EGP',
          description:
            purpose === 'course' && course
              ? `اشتراك كورس: ${course.title}`
              : `شحن محفظة الطالب: ${student.name}`,
          chargeItems: [
            {
              itemId: course?.id || 'wallet-topup',
              description: course?.title || 'شحن رصيد المحفظة',
              price: amountFormatted,
              quantity: 1,
            },
          ],
          paymentExpiry: Date.now() + 24 * 3_600_000,
          signature,
        };

        const fawryRes = await fetch(`${cfg.apiBase}/charge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fawryPayload),
        });
        const fawryData = (await fawryRes.json()) as {
          statusCode?: number;
          statusDescription?: string;
          referenceNumber?: string;
          expirationTime?: number;
        };
        if (!fawryRes.ok || !fawryData.referenceNumber) {
          res.status(502).json({
            error: fawryData.statusDescription || 'تعذر إصدار كود الدفع من بوابة فوري، راجع بيانات التاجر',
          });
          return;
        }
        referenceNumber = String(fawryData.referenceNumber);
        orderMode = cfg.mode;
      } catch {
        res.status(502).json({ error: 'تعذر الاتصال بخادم فوري باي حالياً، حاول مرة أخرى' });
        return;
      }
    } else {
      const randDigits = String(crypto.randomInt(100000, 999999));
      referenceNumber = `924${randDigits}`;
      orderMode = 'sandbox';
    }

    const order: FawryOrder = {
      id: merchantRefNum,
      referenceNumber,
      studentId: student.id,
      studentName: student.name,
      studentPhone: student.phone,
      purpose,
      courseId: course?.id,
      courseTitle: course?.title,
      amountEgp,
      status: 'UNPAID',
      mode: orderMode,
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    state.fawryOrders.unshift(order);
    saveStore(state);

    res.status(201).json({
      order,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/payments/fawry/webhook', (req, res) => {
    const body = req.body as {
      fawryRefNumber?: string;
      merchantRefNumber?: string;
      merchantRefNum?: string;
      paymentAmount?: number | string;
      orderAmount?: number | string;
      orderStatus?: string;
      paymentMethod?: string;
      paymentRefrenceNumber?: string;
      messageSignature?: string;
    };

    const merchantRef = String(body.merchantRefNumber || body.merchantRefNum || '').trim();
    const order = state.fawryOrders.find((o) => o.id === merchantRef);
    if (!order) {
      res.status(404).json({ error: 'طلب الدفع غير موجود' });
      return;
    }

    const cfg = getFawryConfig();
    if (cfg.configured) {
      const paymentAmt = Number(body.paymentAmount ?? order.amountEgp).toFixed(2);
      const orderAmt = Number(body.orderAmount ?? order.amountEgp).toFixed(2);
      const expectedSig = sha256Hex(
        `${String(body.fawryRefNumber || '')}${merchantRef}${paymentAmt}${orderAmt}${String(
          body.orderStatus || ''
        )}${String(body.paymentMethod || '')}${String(body.paymentRefrenceNumber || '')}${cfg.securityKey}`
      );
      if (!safeEqualHex(String(body.messageSignature || ''), expectedSig)) {
        res.status(401).json({ error: 'توقيع فوري غير صالح' });
        return;
      }
    } else if (order.mode !== 'sandbox') {
      res.status(403).json({ error: 'عملية فوري المباشرة تتطلب مفتاح التاجر' });
      return;
    }

    const status = String(body.orderStatus || '').toUpperCase();
    if (status === 'PAID') {
      const student = fulfillFawryOrder(order);
      res.json({ ok: true, order, student, snapshot: getPublicSnapshot(state) });
      return;
    }

    if (status === 'EXPIRED' || status === 'FAILED' || status === 'CANCELED') {
      order.status = status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
      saveStore(state);
    }

    res.json({ ok: true, order, snapshot: getPublicSnapshot(state) });
  });

  app.post('/api/payments/fawry/sandbox-confirm', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const { orderId, studentId } = req.body as { orderId?: string; studentId?: string };
    const order = state.fawryOrders.find((o) => o.id === orderId);
    if (!order) {
      res.status(404).json({ error: 'فاتورة فوري غير موجودة' });
      return;
    }
    if (order.mode !== 'sandbox') {
      res.status(403).json({ error: 'لا يمكن محاكاة الدفع في وضع التشغيل الفعلي، انتظر إشعار فوري الرسمي' });
      return;
    }
    const requesterId = authedStudent?.id || studentId;
    if (requesterId !== order.studentId) {
      res.status(403).json({ error: 'غير مصرح بتأكيد هذه الفاتورة لهذا الحساب' });
      return;
    }

    const student = fulfillFawryOrder(order);
    res.json({
      ok: true,
      order,
      student,
      snapshot: getPublicSnapshot(state),
      message:
        order.purpose === 'course'
          ? `تم سداد فاتورة فوري (${order.referenceNumber}) وفتح الكورس والمنهج والامتحان تلقائياً`
          : `تم سداد فاتورة فوري (${order.referenceNumber}) وإضافة ${order.amountEgp} ج.م إلى محفظتك`,
    });
  });

  app.post('/api/curriculum/authorized', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const { studentId, courseId, grade } = req.body as {
      studentId?: string;
      courseId?: string;
      grade?: GradeLevel | 'all';
    };
    const student = authedStudent || state.students.find((s) => s.id === studentId) || null;

    if (courseId) {
      const course = state.courses.find((c) => c.id === courseId);
      if (!course) {
        res.status(404).json({ error: 'المادة غير موجودة' });
        return;
      }
      if (!isStudentCourseUnlocked(course, student)) {
        res.status(403).json({
          error: 'تنزيل المنهج مغلق — يجب دفع قيمة الكورس الشهري أو تفعيله أولاً لفتح التحميل',
        });
        return;
      }
      const exam = state.exams.find((e) => e.id === course.examId) || null;
      res.json({ courses: [course], exams: exam ? [exam] : [] });
      return;
    }

    const targetGrade = grade || 'all';
    const matching =
      targetGrade === 'all' ? state.courses : state.courses.filter((c) => c.grade === targetGrade);
    const unlockedCourses = matching.filter((c) => isStudentCourseUnlocked(c, student));

    if (unlockedCourses.length === 0) {
      res.status(403).json({
        error: 'لا توجد مواد مدفوعة أو مفعلة على حسابك في هذا الصف. اشترك أولاً لتنزيل المنهج.',
      });
      return;
    }

    const unlockedExamIds = new Set(unlockedCourses.map((c) => c.examId));
    const unlockedExams = state.exams.filter((e) => unlockedExamIds.has(e.id));
    res.json({ courses: unlockedCourses, exams: unlockedExams });
  });

  app.post('/api/attendance/record', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const {
      studentId,
      lessonId,
      watchedPercent,
      watchedSeconds,
      lastPositionSec,
      lastSceneIndex,
      checkedIn,
    } = req.body as {
      studentId?: string;
      lessonId?: string;
      watchedPercent?: number;
      watchedSeconds?: number;
      lastPositionSec?: number;
      lastSceneIndex?: number;
      checkedIn?: boolean;
    };

    const student = authedStudent || state.students.find((s) => s.id === studentId) || null;
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول بحساب الطالب لتسجيل حضور المحاضرة' });
      return;
    }

    const parentCourse = state.courses.find((c) => c.lessons.some((l) => l.id === lessonId));
    if (!parentCourse || !lessonId) {
      res.status(404).json({ error: 'المحاضرة غير موجودة' });
      return;
    }
    if (!isStudentCourseUnlocked(parentCourse, student)) {
      res.status(403).json({ error: 'الكورس مغلق — يجب السداد أولاً لتسجيل الحضور' });
      return;
    }

    const nowIso = new Date().toISOString();
    const safePct = Math.min(100, Math.max(0, Math.round(Number(watchedPercent || 0))));
    const safeSec = Math.max(0, Math.round(Number(watchedSeconds || 0)));
    const hasPosSec = typeof lastPositionSec === 'number' && Number.isFinite(lastPositionSec);
    const safePosSec = hasPosSec ? Math.max(0, Math.round(lastPositionSec)) : undefined;
    const hasSceneIdx = typeof lastSceneIndex === 'number' && Number.isFinite(lastSceneIndex);
    const safeSceneIdx = hasSceneIdx ? Math.max(0, Math.round(lastSceneIndex)) : undefined;

    let att = state.attendances.find(
      (a) => a.studentId === student.id && a.lessonId === lessonId
    );
    if (!att) {
      att = {
        id: `att-${student.id}-${lessonId}`,
        studentId: student.id,
        courseId: parentCourse.id,
        lessonId,
        watchedPercent: safePct,
        watchedSeconds: safeSec,
        lastPositionSec: safePosSec,
        lastSceneIndex: safeSceneIdx,
        checkedIn: Boolean(checkedIn) || safePct > 0,
        fullyWatched: (Boolean(checkedIn) || safePct > 0) && safePct >= 90,
        firstAttendedAt: nowIso,
        lastActivityAt: nowIso,
      };
      state.attendances.unshift(att);
    } else {
      att.watchedPercent = Math.max(att.watchedPercent, safePct);
      att.watchedSeconds = Math.max(att.watchedSeconds, safeSec);
      if (safePosSec !== undefined) att.lastPositionSec = safePosSec;
      if (safeSceneIdx !== undefined) att.lastSceneIndex = safeSceneIdx;
      att.checkedIn = att.checkedIn || Boolean(checkedIn) || att.watchedPercent > 0;
      att.fullyWatched = att.fullyWatched || (att.checkedIn && att.watchedPercent >= 90);
      att.lastActivityAt = nowIso;
    }

    let newlyIssuedCertificate: Certificate | null = null;
    if (att.fullyWatched) {
      if (!student.completedLessonIds.includes(lessonId)) {
        const lessonObj = parentCourse.lessons.find((l) => l.id === lessonId);
        student.completedLessonIds.push(lessonId);
        student.totalWatchMinutes += Number(lessonObj?.durationMin || 25);
        student.points += 40;
      }
      att.completedAt = att.completedAt || nowIso;
      const certRes = ensureCourseCertificate(state, student, parentCourse, true);
      if (certRes.issued) {
        newlyIssuedCertificate = certRes.certificate;
      }
    }

    saveStore(state);
    res.json({
      attendance: att,
      student,
      snapshot: getPublicSnapshot(state),
      newlyIssuedCertificate,
    });
  });

  app.post('/api/lessons/:lessonId/complete', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const { studentId, durationMin } = req.body as { studentId?: string; durationMin?: number };
    const student = authedStudent || state.students.find((s) => s.id === studentId) || null;
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول لحفظ تقدمك' });
      return;
    }

    const lessonId = req.params.lessonId;
    const parentCourse = state.courses.find((c) => c.lessons.some((l) => l.id === lessonId));
    if (!parentCourse) {
      res.status(404).json({ error: 'الدرس غير موجود' });
      return;
    }
    if (!isStudentCourseUnlocked(parentCourse, student)) {
      res.status(403).json({ error: 'الكورس مغلق — يجب الدفع وتفعيل الكورس الشهري أولاً' });
      return;
    }

    const att = state.attendances.find(
      (a) => a.studentId === student.id && a.lessonId === lessonId
    );
    if (!att || !att.checkedIn || !att.fullyWatched) {
      res.status(403).json({
        error:
          'يرجى تسجيل حضور المحاضرة ومشاهدة الفيديو الكرتوني بالكامل (90% فأكثر) أولاً لتأكيد الإتمام',
      });
      return;
    }

    const nowIso = new Date().toISOString();
    att.completedAt = att.completedAt || nowIso;

    if (!student.completedLessonIds.includes(lessonId)) {
      student.completedLessonIds.push(lessonId);
      student.totalWatchMinutes += Number(durationMin || 25);
      student.points += 40;
    }

    const certResult = ensureCourseCertificate(state, student, parentCourse, true);
    saveStore(state);

    res.json({
      student,
      snapshot: getPublicSnapshot(state),
      newlyIssuedCertificate: certResult.issued ? certResult.certificate : null,
    });
  });

  app.post('/api/certificates/:certificateId/authorize', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const { studentId } = req.body as { studentId?: string };
    const student = authedStudent || state.students.find((s) => s.id === studentId) || null;
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول بحساب الطالب أولاً لتحميل الشهادة' });
      return;
    }

    const cert = state.certificates.find((c) => c.id === req.params.certificateId);
    if (!cert) {
      res.status(404).json({ error: 'الشهادة غير موجودة' });
      return;
    }
    if (cert.studentId !== student.id) {
      res.status(403).json({ error: 'غير مصرح بتحميل شهادة طالب آخر' });
      return;
    }

    const course = state.courses.find((c) => c.id === cert.courseId);
    if (course && !isCourseUnlockedForStudent(course, student)) {
      res.status(403).json({ error: 'الكورس مغلق — يجب تفعيل الكورس أولاً' });
      return;
    }

    if (course) {
      const attendedCount = getVerifiedAttendedCount(state, student.id, course);
      const totalCount = course.lessons.length;
      if (attendedCount < totalCount) {
        res.status(403).json({
          error: `لا يمكن تحميل الشهادة قبل التأكد من تسجيل حضور ومشاهدة الـ ${totalCount} محاضرات كاملة (${attendedCount}/${totalCount})`,
        });
        return;
      }
    }

    res.json({ certificate: cert });
  });

  app.post('/api/exams/:examId/submit', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const { studentId, answers } = req.body as { studentId?: string; answers?: number[] };
    const exam = state.exams.find((e) => e.id === req.params.examId);
    if (!exam) {
      res.status(404).json({ error: 'الامتحان غير موجود' });
      return;
    }

    const parentCourse = state.courses.find((c) => c.id === exam.courseId);
    const student = authedStudent || state.students.find((s) => s.id === studentId) || null;
    if (parentCourse && !isStudentCourseUnlocked(parentCourse, student)) {
      res.status(403).json({
        error: 'الامتحان الإلكتروني مغلق — يجب دفع قيمة الكورس الشهري أولاً لفتح الاختبار',
      });
      return;
    }

    const safeAnswers = Array.isArray(answers) ? answers : [];
    let score = 0;
    exam.questions.forEach((q, idx) => {
      if (safeAnswers[idx] === q.correctIndex) {
        score += 1;
      }
    });
    const total = exam.questions.length;
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    const passed = percentage >= exam.passingScore;

    const attempt: ExamAttempt = {
      id: `att-${Date.now()}`,
      examId: exam.id,
      courseId: exam.courseId,
      studentId: student?.id || 'guest',
      studentName: student?.name || 'طالب زائر',
      score,
      total,
      percentage,
      passed,
      answers: safeAnswers,
      submittedAt: new Date().toISOString(),
    };

    if (student) {
      state.examAttempts.unshift(attempt);
      student.points += score * 25 + (passed ? 50 : 10);
      saveStore(state);
    }

    res.json({
      attempt,
      student: student || null,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/admin/codes', (req, res) => {
    const { courseId, count } = req.body as { courseId?: string; count?: number };
    const safeCount = Math.min(20, Math.max(1, Math.round(Number(count || 1))));
    const targetCourseId = courseId || 'ALL';

    const created: ActivationCode[] = [];
    for (let i = 0; i < safeCount; i++) {
      const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
      const prefix = targetCourseId === 'ALL' ? 'VIP' : 'PRIM';
      const codeObj: ActivationCode = {
        code: `QEMA-${prefix}-${rand}`,
        courseId: targetCourseId,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      state.activationCodes.unshift(codeObj);
      created.push(codeObj);
    }

    saveStore(state);
    res.status(201).json({
      created,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/admin/wallet-requests/:id/resolve', (req, res) => {
    const { decision } = req.body as { decision?: 'approved' | 'rejected' };
    const reqObj = state.walletRequests.find((w) => w.id === req.params.id);
    if (!reqObj) {
      res.status(404).json({ error: 'الطلب غير موجود' });
      return;
    }
    if (reqObj.status !== 'pending') {
      res.status(409).json({ error: 'تمت مراجعة هذا الطلب مسبقاً' });
      return;
    }

    reqObj.status = decision === 'rejected' ? 'rejected' : 'approved';
    if (reqObj.status === 'approved') {
      const student = state.students.find((s) => s.id === reqObj.studentId);
      if (student) {
        student.walletBalance = Number((student.walletBalance + reqObj.amountEgp).toFixed(2));
      }
      recordPaymentToTeacherWallet(state, {
        amountEgp: reqObj.amountEgp,
        sourceMethod: reqObj.method,
        student: student || null,
        referenceNumber: reqObj.referenceNumber,
        note: `اعتماد شحن محفظة الطالب (${reqObj.studentName})`,
      });
    }
    saveStore(state);

    res.json({
      request: reqObj,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.patch('/api/admin/payout-settings', (req, res) => {
    const body = req.body as Partial<TeacherPayoutSettings>;
    const validMethod: TopupMethod =
      body.destinationMethod === 'instapay' || body.destinationMethod === 'fawry'
        ? body.destinationMethod
        : body.destinationMethod === 'vodafone_cash'
          ? 'vodafone_cash'
          : state.payoutSettings.destinationMethod;

    const cleanPhone =
      typeof body.destinationPhone === 'string' && body.destinationPhone.trim().length >= 8
        ? normalizePhone(body.destinationPhone)
        : state.payoutSettings.destinationPhone;

    const autoEnabled =
      typeof body.autoTransferEnabled === 'boolean'
        ? body.autoTransferEnabled
        : state.payoutSettings.autoTransferEnabled;

    state.payoutSettings = {
      autoTransferEnabled: autoEnabled,
      destinationMethod: validMethod,
      destinationPhone: cleanPhone || state.profile.hotline || '01029121467',
      destinationLabel:
        typeof body.destinationLabel === 'string' && body.destinationLabel.trim()
          ? body.destinationLabel.trim()
          : state.payoutSettings.destinationLabel,
    };

    // If auto-transfer was enabled and there is pending wallet balance, transfer it immediately
    if (state.payoutSettings.autoTransferEnabled && state.teacherWalletBalance > 0) {
      const amount = Number(state.teacherWalletBalance.toFixed(2));
      const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
      const destMethodLabel =
        state.payoutSettings.destinationMethod === 'instapay'
          ? 'إنستاباي'
          : state.payoutSettings.destinationMethod === 'fawry'
            ? 'حساب فوري'
            : 'فودافون كاش';
      state.teacherWalletBalance = 0;
      state.teacherTotalTransferredEgp = Number((state.teacherTotalTransferredEgp + amount).toFixed(2));
      state.teacherTransactions.unshift({
        id: `tx-out-${Date.now()}-${suffix}`,
        type: 'auto_payout',
        amountEgp: amount,
        sourceMethod: state.payoutSettings.destinationMethod === 'fawry' ? 'fawry' : state.payoutSettings.destinationMethod,
        destinationPhone: state.payoutSettings.destinationPhone,
        referenceNumber: `PAYOUT-${suffix}-${Date.now().toString().slice(-4)}`,
        status: 'transferred',
        note: `تصفية وتحويل الرصيد المعلق تلقائياً عبر ${destMethodLabel} إلى ${state.payoutSettings.destinationPhone}`,
        createdAt: new Date().toISOString(),
      });
    }

    saveStore(state);
    res.json({
      payoutSettings: state.payoutSettings,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/admin/payouts/transfer-now', (req, res) => {
    const body = req.body as { amountEgp?: number };
    const available = Number(state.teacherWalletBalance || 0);
    if (available <= 0) {
      res.status(400).json({ error: 'لا يوجد رصيد معلق في المحفظة للتحويل حالياً' });
      return;
    }

    const requested =
      typeof body.amountEgp === 'number' && Number.isFinite(body.amountEgp) && body.amountEgp > 0
        ? Math.min(available, Math.round(body.amountEgp * 100) / 100)
        : available;

    const destPhone =
      normalizePhone(state.payoutSettings.destinationPhone || state.profile.hotline) || '01029121467';
    const destMethodLabel =
      state.payoutSettings.destinationMethod === 'instapay'
        ? 'إنستاباي'
        : state.payoutSettings.destinationMethod === 'fawry'
          ? 'حساب فوري'
          : 'فودافون كاش';
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();

    const tx: TeacherWalletTransaction = {
      id: `tx-man-${Date.now()}-${suffix}`,
      type: 'manual_payout',
      amountEgp: requested,
      sourceMethod:
        state.payoutSettings.destinationMethod === 'fawry'
          ? 'fawry'
          : state.payoutSettings.destinationMethod,
      destinationPhone: destPhone,
      referenceNumber: `TRN-${suffix}-${Date.now().toString().slice(-4)}`,
      status: 'transferred',
      note: `تحويل يدوي فوري عبر ${destMethodLabel} إلى ${destPhone}`,
      createdAt: new Date().toISOString(),
    };

    state.teacherWalletBalance = Math.max(0, Number((available - requested).toFixed(2)));
    state.teacherTotalTransferredEgp = Number((state.teacherTotalTransferredEgp + requested).toFixed(2));
    state.teacherTransactions.unshift(tx);
    saveStore(state);

    res.json({
      transaction: tx,
      snapshot: getPublicSnapshot(state),
      message: `تم تحويل ${requested} ج.م بنجاح إلى ${destPhone} (${tx.referenceNumber})`,
    });
  });

  app.post('/api/admin/courses', (req, res) => {
    const body = req.body as {
      title?: string;
      subtitle?: string;
      grade?: GradeLevel;
      branch?: SubjectBranch;
      monthLabel?: string;
      priceEgp?: number;
      totalHours?: number;
      firstLessonTitle?: string;
    };

    const title = String(body.title || '').trim();
    const subtitle = String(body.subtitle || '').trim();
    if (title.length < 3 || subtitle.length < 5) {
      res.status(400).json({ error: 'يرجى إدخال عنوان الكورس ووصف مختصر له' });
      return;
    }

    const validGrades: GradeLevel[] = ['kg', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const grade: GradeLevel = validGrades.includes(body.grade as GradeLevel)
      ? (body.grade as GradeLevel)
      : 'p4';

    const validBranches: SubjectBranch[] = [
      'arabic',
      'math',
      'kg_arabic',
      'kg_math',
      'kg_english',
      'kg_discover',
    ];
    const branch: SubjectBranch = validBranches.includes(body.branch as SubjectBranch)
      ? (body.branch as SubjectBranch)
      : 'arabic';

    const courseId = `crs-${Date.now()}`;
    const examId = `exam-${Date.now()}`;
    const coverByBranch: Record<SubjectBranch, string> = {
      arabic: '/src/assets/images/course_arabic_primary_1795354179025.jpg',
      math: '/src/assets/images/course_math_primary_1795354180095.jpg',
      kg_arabic: '/src/assets/images/kg_foundation_banner_1795354180015.jpg',
      kg_math: '/src/assets/images/course_math_primary_1795354180095.jpg',
      kg_english: '/src/assets/images/kg_foundation_banner_1795354180015.jpg',
      kg_discover: '/src/assets/images/primary_hero_banner_1795354179862.jpg',
    };

    const firstLesson: Lesson = {
      id: `les-${Date.now()}`,
      order: 1,
      title: String(body.firstLessonTitle || 'الدرس التمهيدي الأول').trim(),
      durationMin: 30,
      videoSummary: subtitle,
      keyFormulas: ['ملخص الدرس والأفكار الأساسية'],
      slides: [
        {
          heading: 'أهداف الدرس الأول',
          formula: title,
          note: subtitle,
        },
      ],
      handoutTitle: `ملزمة ${title}`,
      handoutSummary: 'ملخص القواعد والأسئلة التدريبية.',
      isFreePreview: true,
    };

    const newCourse: Course = {
      id: courseId,
      title,
      subtitle,
      grade,
      branch,
      monthLabel: String(body.monthLabel || 'كورس جديد').trim(),
      priceEgp: Math.max(0, Math.round(Number(body.priceEgp || 0))),
      coverImage: coverByBranch[branch],
      totalHours: Math.max(1, Math.round(Number(body.totalHours || 8))),
      lessons: [firstLesson],
      examId,
    };

    const newExam: Exam = {
      id: examId,
      courseId,
      title: `اختبار تقييم: ${title}`,
      durationMin: 12,
      passingScore: 50,
      questions: [
        {
          id: `q-${Date.now()}-1`,
          prompt: 'سؤال تقييمي تجريبي على الدرس الأول:',
          options: ['الإجابة الصحيحة الأولى', 'خيار آخر', 'خيار ثالث', 'خيار رابع'],
          correctIndex: 0,
          explanation: 'تم إعداد هذا الاختبار تلقائياً عند إنشاء الكورس.',
        },
      ],
    };

    state.courses.unshift(newCourse);
    state.exams.unshift(newExam);
    saveStore(state);

    res.status(201).json({
      course: newCourse,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/admin/courses/:courseId/lessons', (req, res) => {
    const course = state.courses.find((c) => c.id === req.params.courseId);
    if (!course) {
      res.status(404).json({ error: 'الكورس غير موجود' });
      return;
    }
    const { title, durationMin, videoSummary, formula, isFreePreview } = req.body as {
      title?: string;
      durationMin?: number;
      videoSummary?: string;
      formula?: string;
      isFreePreview?: boolean;
    };
    const cleanTitle = String(title || '').trim();
    if (cleanTitle.length < 3) {
      res.status(400).json({ error: 'يرجى إدخال عنوان الدرس' });
      return;
    }

    const newLesson: Lesson = {
      id: `les-${Date.now()}`,
      order: course.lessons.length + 1,
      weekNumber: Math.ceil((course.lessons.length + 1) / 2),
      title: cleanTitle,
      durationMin: Math.max(10, Math.round(Number(durationMin || 30))),
      videoSummary: String(videoSummary || 'شرح مبسط وتدريبات متدرجة.').trim(),
      keyFormulas: [String(formula || 'القاعدة الأساسية للدرس').trim()],
      slides: [
        {
          heading: cleanTitle,
          formula: String(formula || 'القاعدة الأساسية للدرس').trim(),
          note: String(videoSummary || 'شرح مبسط وتدريبات متدرجة.').trim(),
        },
      ],
      handoutTitle: `ملزمة ${cleanTitle}`,
      handoutSummary: 'تمارين إضافية وأنشطة منزلية.',
      isFreePreview: Boolean(isFreePreview),
    };

    course.lessons.push(newLesson);
    saveStore(state);

    res.status(201).json({
      lesson: newLesson,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/admin/announcements', (req, res) => {
    const { title, body, grade } = req.body as {
      title?: string;
      body?: string;
      grade?: GradeLevel | 'all';
    };
    if (!title?.trim() || !body?.trim()) {
      res.status(400).json({ error: 'يرجى كتابة عنوان ونص التنبيه' });
      return;
    }
    const ann: Announcement = {
      id: `ann-${Date.now()}`,
      title: title.trim(),
      body: body.trim(),
      grade: grade || 'all',
      createdAt: new Date().toISOString(),
    };
    state.announcements.unshift(ann);
    saveStore(state);
    res.status(201).json({ announcement: ann, snapshot: getPublicSnapshot(state) });
  });

  app.patch('/api/admin/profile', (req, res) => {
    const body = req.body as Partial<AcademyProfile>;
    state.profile = {
      ...state.profile,
      platformName: body.platformName?.trim() || state.profile.platformName,
      teacherName: body.teacherName?.trim() || state.profile.teacherName,
      teacherTitle: body.teacherTitle?.trim() || state.profile.teacherTitle,
      teacherBio: body.teacherBio?.trim() || state.profile.teacherBio,
      hotline: body.hotline?.trim() || state.profile.hotline,
    };
    saveStore(state);
    res.json({ profile: state.profile, snapshot: getPublicSnapshot(state) });
  });

  app.post('/api/lessons/:lessonId/reviews', (req, res) => {
    const authedStudent = getSessionStudent(req);
    const { lessonId } = req.params;
    const { studentId, audioRating, contentRating, comment } = req.body as {
      studentId?: string;
      audioRating?: number;
      contentRating?: number;
      comment?: string;
    };

    const student = authedStudent || state.students.find((s) => s.id === studentId) || null;
    if (!student) {
      res.status(401).json({ error: 'يرجى تسجيل الدخول بحساب الطالب أولاً لتقييم الدرس' });
      return;
    }

    const parentCourse = state.courses.find((c) => c.lessons.some((l) => l.id === lessonId));
    const lessonObj = parentCourse?.lessons.find((l) => l.id === lessonId);
    if (!parentCourse || !lessonObj) {
      res.status(404).json({ error: 'الدرس غير موجود' });
      return;
    }

    if (!isStudentCourseUnlocked(parentCourse, student)) {
      res.status(403).json({ error: 'يجب الاشتراك في الكورس أولاً قبل تقييم الدروس' });
      return;
    }

    const att = state.attendances.find(
      (a) => a.studentId === student.id && a.lessonId === lessonId
    );
    const isCompleted =
      student.completedLessonIds.includes(lessonId) || Boolean(att && att.fullyWatched);
    if (!isCompleted) {
      res.status(403).json({
        error: 'لا يمكن إرسال التقييم إلا بعد الانتهاء من مشاهدة الدرس كاملاً (90% فأكثر).',
      });
      return;
    }

    const safeAudio = Math.min(5, Math.max(1, Math.round(Number(audioRating || 0))));
    const safeContent = Math.min(5, Math.max(1, Math.round(Number(contentRating || 0))));
    if (!Number.isFinite(Number(audioRating)) || !Number.isFinite(Number(contentRating))) {
      res.status(400).json({ error: 'يرجى اختيار تقييم من 1 إلى 5 نجوم للشرح الصوتي والمحتوى' });
      return;
    }

    const cleanComment = String(comment || '').trim().slice(0, 600);
    const overallRating = Number(((safeAudio + safeContent) / 2).toFixed(1));
    const nowIso = new Date().toISOString();

    const existing = state.lessonReviews.find(
      (r) => r.studentId === student.id && r.lessonId === lessonId
    );

    if (existing) {
      existing.audioRating = safeAudio;
      existing.contentRating = safeContent;
      existing.overallRating = overallRating;
      existing.comment = cleanComment;
      existing.updatedAt = nowIso;
      saveStore(state);
      res.json({
        updated: true,
        review: existing,
        student,
        snapshot: getPublicSnapshot(state),
      });
      return;
    }

    const review: LessonReview = {
      id: `rev-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      studentId: student.id,
      studentName: student.name,
      courseId: parentCourse.id,
      courseTitle: parentCourse.title,
      lessonId: lessonObj.id,
      lessonTitle: lessonObj.title,
      grade: parentCourse.grade,
      branch: parentCourse.branch,
      audioRating: safeAudio,
      contentRating: safeContent,
      overallRating,
      comment: cleanComment,
      createdAt: nowIso,
    };

    state.lessonReviews.unshift(review);
    student.points += 15;
    saveStore(state);

    res.status(201).json({
      updated: false,
      review,
      student,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.get('/api/admin/export-backup', (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const filename = `naglaa-academy-backup-${today}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(getPublicSnapshot(state), null, 2));
  });

  app.get('/api/admin/export-bundle', (_req, res) => {
    const filename = 'platform-naglaa-fathi-server.tar.gz';
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const tarArgs = [
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=.env',
      '--exclude=.env.local',
      '--exclude=.env.*.local',
      '--exclude=dist',
      '--exclude=.aistudio',
      '--exclude=data/*.json',
      '-czf',
      '-',
      '.',
    ];
    const tarProc = spawn('tar', tarArgs, { cwd: __dirname });
    let errLog = '';
    tarProc.stderr.on('data', (chunk) => {
      errLog += String(chunk);
    });
    tarProc.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'تعذر تجهيز ملف السيرفر للتحميل' });
      } else {
        res.end();
      }
    });
    tarProc.on('close', (code) => {
      if (code !== 0) {
        console.error('tar export failed:', code, errLog);
        if (!res.headersSent) {
          res.status(500).json({ error: 'تعذر ضغط ملفات المنصة' });
        }
      }
    });
    tarProc.stdout.pipe(res);
  });

  app.get('/api/admin/export-github-zip', (_req, res) => {
    try {
      const excludedDirs = new Set([
        'node_modules',
        '.git',
        'dist',
        '.aistudio',
        '.gmp_cache',
        'android-build',
        'data',
      ]);
      const excludedFiles = new Set([
        '.env',
        '.env.local',
        '.DS_Store',
        'bun.lock',
      ]);
      const entries: { name: string; content: Buffer }[] = [];

      const walk = (dir: string, relPrefix: string) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            if (excludedDirs.has(item.name)) continue;
            const nextRel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
            walk(path.join(dir, item.name), nextRel);
          } else if (item.isFile()) {
            if (
              excludedFiles.has(item.name) ||
              item.name.startsWith('.env.') && item.name !== '.env.example' ||
              item.name.endsWith('.log') ||
              item.name.endsWith('.tar.gz') ||
              item.name.endsWith('.zip')
            ) {
              continue;
            }
            const entryName = relPrefix
              ? `naglaa-fathi-academy/${relPrefix}/${item.name}`
              : `naglaa-fathi-academy/${item.name}`;
            entries.push({
              name: entryName,
              content: fs.readFileSync(path.join(dir, item.name)),
            });
          }
        }
      };

      walk(__dirname, '');
      const zipBuffer = buildZipBuffer(entries);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="naglaa-fathi-academy-github.zip"');
      res.send(zipBuffer);
    } catch (err) {
      console.error('github zip export failed:', err);
      res.status(500).json({ error: 'تعذر تجهيز ملف GitHub بصيغة ZIP' });
    }
  });

  app.get('/api/admin/export-odoo-module', (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const hostHeader = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
    const fallbackUrl =
      process.env.APP_URL ||
      (hostHeader ? `${forwardedProto}://${hostHeader}` : 'https://ais-pre-kpzrcgz2rkdojvesw72oll-286129243002.europe-west2.run.app');

    let targetUrl = fallbackUrl;
    if (rawUrl) {
      try {
        const parsedUrl = new URL(rawUrl);
        if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
          targetUrl = parsedUrl.toString().replace(/\/+$/, '');
        }
      } catch {
        // Keep safe fallbackUrl
      }
    }

    const xmlSafeUrl = targetUrl
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const initPy = `# -*- coding: utf-8 -*-\n`;
    const manifestPy = `# -*- coding: utf-8 -*-
{
    "name": "منصة الأستاذة نجلاء فتحي التعليمية",
    "summary": "إضافة صفحة وقائمة للأكاديمية التعليمية داخل موقع Odoo",
    "version": "1.0.0",
    "category": "Website",
    "author": "منصة الأستاذة نجلاء فتحي",
    "depends": ["website"],
    "data": [
        "views/academy_page.xml",
    ],
    "installable": True,
    "application": True,
    "license": "LGPL-3",
}
`;
    const academyPageXml = `<?xml version="1.0" encoding="utf-8"?>
<odoo>
  <template id="naglaa_academy_template" name="منصة الأستاذة نجلاء فتحي">
    <t t-call="website.layout">
      <div id="wrap" class="oe_structure">
        <div class="container-fluid px-0">
          <iframe
            src="${xmlSafeUrl}"
            width="100%"
            height="920"
            style="border:0;width:100%;min-height:920px;display:block;"
            allow="clipboard-write; autoplay"
            loading="lazy"
            title="منصة الأستاذة نجلاء فتحي"
          />
        </div>
      </div>
    </t>
  </template>

  <record id="naglaa_academy_page" model="website.page">
    <field name="name">منصة الأستاذة نجلاء فتحي</field>
    <field name="type">qweb</field>
    <field name="url">/academy</field>
    <field name="website_indexed" eval="True"/>
    <field name="is_published" eval="True"/>
    <field name="view_id" ref="naglaa_academy_template"/>
  </record>

  <record id="naglaa_academy_menu" model="website.menu">
    <field name="name">الأكاديمية التعليمية</field>
    <field name="url">/academy</field>
    <field name="page_id" ref="naglaa_academy_page"/>
    <field name="parent_id" ref="website.main_menu"/>
    <field name="sequence" type="int">55</field>
  </record>
</odoo>
`;
    const readmeMd = `# موديول ربط منصة الأستاذة نجلاء فتحي مع Odoo Website

1. هذا الموديول متوافق مع Odoo (Community / Enterprise / Odoo.sh عبر مجلد custom addons).
2. ضع مجلد naglaa_fathi_academy داخل مجلد addons وأعد تحميل قائمة التطبيقات (Update Apps List)، ثم ثبت التطبيق لتظهر صفحة /academy في موقعك تلقائياً.
3. إذا كنت تستخدم Odoo Online (SaaS) الذي يمنع رفع ملفات zip البرمجية: افتح Website -> Edit -> اسحب أداة Embed Code وألصق رابط المنصة: ${targetUrl}
`;

    const iconSvgPath = path.join(__dirname, 'public', 'icon.svg');
    const iconSvgBuf = fs.existsSync(iconSvgPath)
      ? fs.readFileSync(iconSvgPath)
      : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0F172A"/></svg>', 'utf8');

    const zipBuffer = buildZipBuffer([
      { name: 'naglaa_fathi_academy/__init__.py', content: initPy },
      { name: 'naglaa_fathi_academy/__manifest__.py', content: manifestPy },
      { name: 'naglaa_fathi_academy/views/academy_page.xml', content: academyPageXml },
      { name: 'naglaa_fathi_academy/static/description/icon.svg', content: iconSvgBuf },
      { name: 'naglaa_fathi_academy/README.md', content: readmeMd },
    ]);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="naglaa_fathi_academy_odoo.zip"');
    res.send(zipBuffer);
  });

  app.post('/api/admin/reset', (_req, res) => {
    state = createInitialStore();
    saveStore(state);
    res.json(getPublicSnapshot(state));
  });

  // In-site live chat helpers & REST endpoints (backed by WebSocket broadcast)
  interface ChatClientMeta {
    role: 'student' | 'teacher';
    threadId?: string;
  }
  const chatClients = new Map<WebSocket, ChatClientMeta>();

  const broadcastChatMessage = (message: ChatMessage) => {
    const payload = JSON.stringify({ type: 'chat:message', message });
    chatClients.forEach((meta, client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (meta.role === 'teacher' || meta.threadId === message.threadId) {
        client.send(payload);
      }
    });
  };

  const appendChatMessage = (input: {
    id?: string;
    threadId?: string;
    senderRole?: 'student' | 'teacher';
    senderName?: string;
    senderPhone?: string;
    text?: string;
  }): { message?: ChatMessage; error?: string } => {
    const cleanText = String(input.text || '').trim();
    const threadId = String(input.threadId || '').trim();
    if (!threadId) {
      return { error: 'معرف المحادثة مطلوب' };
    }
    if (cleanText.length === 0 || cleanText.length > 1000) {
      return { error: 'يرجى كتابة رسالة بين 1 و 1000 حرف' };
    }
    const cleanId = String(input.id || '').trim();
    if (cleanId) {
      const existing = state.chatMessages.find((m) => m.id === cleanId);
      if (existing) {
        return { message: existing };
      }
    }

    const senderRole: 'student' | 'teacher' =
      input.senderRole === 'teacher' ? 'teacher' : 'student';
    const message: ChatMessage = {
      id: cleanId || `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      threadId,
      senderRole,
      senderName:
        String(input.senderName || '').trim() ||
        (senderRole === 'teacher' ? state.profile.teacherName : 'طالب / ولي أمر'),
      senderPhone: input.senderPhone ? String(input.senderPhone).trim() : undefined,
      text: cleanText,
      createdAt: new Date().toISOString(),
    };

    state.chatMessages.push(message);
    if (state.chatMessages.length > 500) {
      state.chatMessages = state.chatMessages.slice(-500);
    }
    saveStore(state);
    broadcastChatMessage(message);
    return { message };
  };

  app.get('/api/chat/messages', (req, res) => {
    const threadId = String(req.query.threadId || '').trim();
    const role = String(req.query.role || 'student').trim();
    if (role === 'teacher') {
      res.json({ messages: state.chatMessages });
      return;
    }
    const filtered = threadId
      ? state.chatMessages.filter((m) => m.threadId === threadId)
      : [];
    res.json({ messages: filtered });
  });

  app.post('/api/chat/messages', (req, res) => {
    const body = req.body as {
      id?: string;
      threadId?: string;
      senderRole?: 'student' | 'teacher';
      senderName?: string;
      senderPhone?: string;
      text?: string;
    };
    const result = appendChatMessage(body);
    if (result.error || !result.message) {
      res.status(400).json({ error: result.error || 'تعذر إرسال الرسالة' });
      return;
    }
    res.status(201).json({ message: result.message });
  });

  const broadcastPushAlert = (event: LecturePushEvent) => {
    const payload = JSON.stringify({
      type: 'push:lecture',
      event,
      lectureSchedules: state.lectureSchedules,
    });
    chatClients.forEach((_meta, client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  };

  const remindedScheduleIds = new Set<string>();
  const pushSchedulerTimer = setInterval(() => {
    const nowMs = Date.now();
    for (const sch of state.lectureSchedules) {
      const targetMs = new Date(sch.scheduledAt).getTime();
      if (!Number.isFinite(targetMs)) continue;
      const diffMin = (targetMs - nowMs) / 60_000;
      if (diffMin >= -5 && diffMin <= sch.remindBeforeMin && !remindedScheduleIds.has(sch.id)) {
        remindedScheduleIds.add(sch.id);
        const minsRounded = Math.max(0, Math.round(diffMin));
        broadcastPushAlert({
          id: `push-${sch.id}-${Date.now()}`,
          scheduleId: sch.id,
          courseId: sch.courseId,
          courseTitle: sch.courseTitle,
          lessonTitle: sch.lessonTitle,
          grade: sch.grade,
          scheduledAt: sch.scheduledAt,
          title:
            minsRounded <= 1
              ? `تبدأ الآن محاضرة: ${sch.lessonTitle}`
              : `اقترب موعد المحاضرة خلال ${minsRounded} دقيقة`,
          body: `${sch.courseTitle} مع ${sch.teacherName}`,
          pushedAt: new Date().toISOString(),
        });
      }
    }
  }, 30_000);
  process.once('exit', () => clearInterval(pushSchedulerTimer));

  app.post('/api/admin/schedules', (req, res) => {
    const body = req.body as {
      courseId?: string;
      lessonId?: string;
      lessonTitle?: string;
      scheduledAt?: string;
      startsInMinutes?: number;
      durationMin?: number;
      remindBeforeMin?: number;
      note?: string;
      pushNow?: boolean;
    };

    const course = state.courses.find((c) => c.id === body.courseId);
    if (!course) {
      res.status(404).json({ error: 'الكورس المختار غير موجود' });
      return;
    }

    const chosenLesson = body.lessonId
      ? course.lessons.find((l) => l.id === body.lessonId)
      : course.lessons[0];
    const cleanLessonTitle =
      String(body.lessonTitle || '').trim() || chosenLesson?.title || course.title;

    let targetIso = '';
    if (typeof body.startsInMinutes === 'number' && Number.isFinite(body.startsInMinutes)) {
      const mins = Math.max(1, Math.min(10_080, Math.round(body.startsInMinutes)));
      targetIso = new Date(Date.now() + mins * 60_000).toISOString();
    } else if (body.scheduledAt) {
      const parsedDate = new Date(body.scheduledAt);
      if (Number.isNaN(parsedDate.getTime())) {
        res.status(400).json({ error: 'تاريخ ووقت المحاضرة غير صالحين' });
        return;
      }
      targetIso = parsedDate.toISOString();
    } else {
      targetIso = new Date(Date.now() + 15 * 60_000).toISOString();
    }

    const remindBeforeMin = Math.max(1, Math.min(120, Math.round(Number(body.remindBeforeMin || 15))));
    const durationMin = Math.max(10, Math.min(180, Math.round(Number(body.durationMin || chosenLesson?.durationMin || 40))));

    const schedule: LiveLectureSchedule = {
      id: `sch-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      courseId: course.id,
      courseTitle: course.title,
      lessonId: chosenLesson?.id,
      lessonTitle: cleanLessonTitle,
      grade: course.grade,
      branch: course.branch,
      teacherName: state.profile.teacherName,
      scheduledAt: targetIso,
      durationMin,
      remindBeforeMin,
      note: body.note ? String(body.note).trim() : undefined,
      createdAt: new Date().toISOString(),
    };

    state.lectureSchedules.unshift(schedule);
    saveStore(state);

    const diffMin = Math.max(0, Math.round((new Date(targetIso).getTime() - Date.now()) / 60_000));
    let pushEvent: LecturePushEvent | null = null;
    if (body.pushNow || diffMin <= remindBeforeMin) {
      remindedScheduleIds.add(schedule.id);
      pushEvent = {
        id: `push-${schedule.id}-${Date.now()}`,
        scheduleId: schedule.id,
        courseId: schedule.courseId,
        courseTitle: schedule.courseTitle,
        lessonTitle: schedule.lessonTitle,
        grade: schedule.grade,
        scheduledAt: schedule.scheduledAt,
        title:
          diffMin <= 1
            ? `تبدأ الآن محاضرة: ${schedule.lessonTitle}`
            : `موعد محاضرة قادمة خلال ${diffMin} دقيقة`,
        body: `${schedule.courseTitle}${schedule.note ? ` — ${schedule.note}` : ''}`,
        pushedAt: new Date().toISOString(),
      };
      broadcastPushAlert(pushEvent);
    }

    res.status(201).json({
      schedule,
      event: pushEvent,
      snapshot: getPublicSnapshot(state),
    });
  });

  app.post('/api/admin/schedules/:id/push', (req, res) => {
    const schedule = state.lectureSchedules.find((s) => s.id === req.params.id);
    if (!schedule) {
      res.status(404).json({ error: 'موعد المحاضرة غير موجود' });
      return;
    }
    const diffMin = Math.max(0, Math.round((new Date(schedule.scheduledAt).getTime() - Date.now()) / 60_000));
    remindedScheduleIds.add(schedule.id);
    const event: LecturePushEvent = {
      id: `push-${schedule.id}-${Date.now()}`,
      scheduleId: schedule.id,
      courseId: schedule.courseId,
      courseTitle: schedule.courseTitle,
      lessonTitle: schedule.lessonTitle,
      grade: schedule.grade,
      scheduledAt: schedule.scheduledAt,
      title:
        diffMin <= 1
          ? `تذكير عاجل: محاضرة «${schedule.lessonTitle}» تبدأ الآن!`
          : `تذكير: محاضرة «${schedule.lessonTitle}» بعد ${diffMin} دقيقة`,
      body: `${schedule.courseTitle} مع ${schedule.teacherName}`,
      pushedAt: new Date().toISOString(),
    };
    broadcastPushAlert(event);
    res.json({ event, snapshot: getPublicSnapshot(state) });
  });

  app.delete('/api/admin/schedules/:id', (req, res) => {
    const idx = state.lectureSchedules.findIndex((s) => s.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'الموعد غير موجود' });
      return;
    }
    state.lectureSchedules.splice(idx, 1);
    saveStore(state);
    res.json({ snapshot: getPublicSnapshot(state) });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const server = http.createServer(app);
  const chatWss = new WebSocketServer({ server, path: '/ws/chat' });

  chatWss.on('connection', (ws) => {
    chatClients.set(ws, { role: 'student' });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as {
          type?: string;
          role?: 'student' | 'teacher';
          threadId?: string;
          id?: string;
          senderRole?: 'student' | 'teacher';
          senderName?: string;
          senderPhone?: string;
          text?: string;
        };

        if (parsed.type === 'chat:subscribe') {
          const role = parsed.role === 'teacher' ? 'teacher' : 'student';
          const threadId = parsed.threadId ? String(parsed.threadId).trim() : undefined;
          chatClients.set(ws, { role, threadId });
          const initMessages =
            role === 'teacher'
              ? state.chatMessages
              : threadId
                ? state.chatMessages.filter((m) => m.threadId === threadId)
                : [];
          ws.send(JSON.stringify({ type: 'chat:init', messages: initMessages }));
          return;
        }

        if (parsed.type === 'chat:send') {
          const result = appendChatMessage({
            id: parsed.id,
            threadId: parsed.threadId,
            senderRole: parsed.senderRole,
            senderName: parsed.senderName,
            senderPhone: parsed.senderPhone,
            text: parsed.text,
          });
          if (result.error) {
            ws.send(JSON.stringify({ type: 'chat:error', error: result.error }));
          }
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => {
      chatClients.delete(ws);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Primary & KG Academy server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
