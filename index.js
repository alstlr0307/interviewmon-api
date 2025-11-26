// api/index.js  (patched final + Railway/Netlify/Vercel 호환 풀버전)
// -----------------------------------------------------------------------------
// - 프리플라이트 강제 응답 제거 (OPTIONS 204 직접 반환 제거)
// - cors() 가 자동으로 OPTIONS 핸들링하도록 구성
// - Trust Proxy, Cookie, RateLimit, Health, Logging 그대로 유지
// - Auth/Sessions/Interview/AI 모든 기능 포함한 Full Version
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const rootEnvPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(rootEnvPath)) dotenv.config({ path: rootEnvPath, override: true });

const os = require('os');
const express = require('express');
const cors = require('cors');
const cookies = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { pool } = require('./db');
const {
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  storeRefresh,
  revokeRefresh,
  isRefreshUsable
} = require('./token');
const { gradeAnswer } = require('./ai');

const app = express();
const parsedPort = parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 4000;
const HOST = process.env.HOST || '0.0.0.0';

// -----------------------------------------------------------------------------
// 1) TRUST PROXY (Railway 필수)
// -----------------------------------------------------------------------------
const TRUST_PROXY_VAL = (() => {
  const v = String(process.env.TRUST_PROXY ?? 'loopback').trim().toLowerCase();
  if (v === 'true') return 'loopback';
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
})();
app.set('trust proxy', TRUST_PROXY_VAL);

// -----------------------------------------------------------------------------
// 2) ETag 비활성화 + 캐시 금지
// -----------------------------------------------------------------------------
app.set('etag', false);

const noCache = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.removeHeader('ETag');
  next();
};

// -----------------------------------------------------------------------------
// 3) CORS (Railway + Netlify/Vercel 호환)
// -----------------------------------------------------------------------------
// env 기반 설정(현재는 사용 안 함, 필요시 app.use(cors(corsOptions))로 교체 가능)
const RAW_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_PRIVATE_LAN = (process.env.CORS_ALLOW_PRIVATE_LAN || 'true') === 'true';
const ALLOW_CREDENTIALS = (process.env.CORS_CREDENTIALS || 'true') === 'true';

const isStar = RAW_ORIGINS.includes('*');

function isPrivateHost(h) {
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    /^192\.168\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)
  );
}

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);

    try {
      const u = new URL(origin);
      const host = u.hostname;

      if (isStar) return cb(null, origin);
      if (RAW_ORIGINS.includes(origin)) return cb(null, origin);
      if (ALLOW_PRIVATE_LAN && isPrivateHost(host)) return cb(null, origin);

      return cb(new Error(`CORS blocked: ${origin}`));
    } catch {
      return cb(new Error(`CORS parse error: ${origin}`));
    }
  },
  credentials: ALLOW_CREDENTIALS,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'content-type',
    'authorization',
    'x-refresh-token',
    'X-Refresh-Token'
  ],
  optionsSuccessStatus: 204
};

// 실제 사용 중인 CORS(화이트리스트 + 쿠키)
// 필요하면 위 corsOptions로 갈아탈 수 있음
app.use(
  cors({
    origin: (origin, cb) => {
      const whitelist = [
        'https://interviewmon-front.vercel.app',
        'https://interviewmon-front-prok4hin3-minsiks-projects-b3256446.vercel.app',
        'http://localhost:3000'
      ];

      // origin 없으면 허용 (서버-서버 요청)
      if (!origin) return cb(null, true);

      if (whitelist.includes(origin)) return cb(null, true);

      return cb(new Error('CORS blocked: ' + origin));
    },
    credentials: true
  })
);

// /api 전역 캐시 금지
app.use('/api', noCache);

// -----------------------------------------------------------------------------
// 4) 보안 / 파서 / 로깅
// -----------------------------------------------------------------------------
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookies());

// 🔑 AccessToken → req.user 세팅 미들웨어
app.use((req, _res, next) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (token) {
    try {
      const payload = verifyAccess(token); // 위에서 import 한 함수
      req.user = payload;                 // { sub, email, role, ... }
    } catch (e) {
      // 토큰이 깨졌거나 만료되면 그냥 익명 처리
      req.user = null;
    }
  } else {
    req.user = null;
  }

  next();
});

// Request ID
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Expose headers
app.use((_, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
  next();
});

// Logger
morgan.token('id', (req) => req.id);
app.use(morgan(':id :method :url :status :res[content-length] - :response-time ms'));

// -----------------------------------------------------------------------------
// 5) Rate Limit
// -----------------------------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false
});

const gradeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GRADE_MAX || process.env.RATE_LIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false
});

// -----------------------------------------------------------------------------
// 6) Helpers
// -----------------------------------------------------------------------------
const asyncH = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  if (req.user && req.user.sub) return next();
  return res.status(401).json({ message: "Unauthorized" });
}

// mock_sessions용으로 쓸 버전만 남기기
async function ensureOwnSession(sessionId, userId) {
  const [rows] = await pool.execute(
    "SELECT id FROM mock_sessions WHERE id=? AND user_id=? LIMIT 1",
    [sessionId, userId]
  );
  return rows.length ? rows[0] : null;
}

// JSON 안전 파서 (로그 NO, 깨지면 fallback 리턴)
function safeJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;
  if (typeof value !== "string") return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// 점수 → 등급 (0~100 기준)
function gradeFromScore(s) {
  if (s >= 90) return "S";
  if (s >= 80) return "A";
  if (s >= 70) return "B";
  if (s >= 60) return "C";
  if (s >= 50) return "D";
  return "F";
}

// AI가 준 0~10 스코어를 조금 너그럽게 보정
function soften10(v) {
  const n = typeof v === "number" ? v : Number(v) || 0;
  if (n <= 3) return n + 2; // 0~3점 → +2
  if (n <= 5) return n + 1; // 4~5점 → +1
  return n;                 // 나머지는 그대로
}

// chart/ scores 를 0~100 스케일로 정규화
function normalizeChartFromAI(rawChart, rawScores) {
  const src = rawChart && Object.keys(rawChart).length ? rawChart : rawScores || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const num = typeof v === "number" ? v : Number(v) || 0;
    // 0~10이면 ×10, 이미 0~100처럼 크면 그대로 clamp
    const base = num <= 10 ? num * 10 : num;
    out[k] = Math.max(0, Math.min(100, Math.round(base)));
  }
  return out;
}

// -----------------------------------------------------------------------------
// 7) Health
// -----------------------------------------------------------------------------
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/health', (_, res) => res.json({ ok: true }));

// -----------------------------------------------------------------------------
// 8) AUTH
// -----------------------------------------------------------------------------
// 회원가입
app.post(
  '/api/auth/register',
  authLimiter,
  asyncH(async (req, res) => {
    let { email, password, displayName } = req.body || {};
    email = String(email || '').trim().toLowerCase();
    displayName = (displayName || '').trim();

    if (!email || !password)
      return res.status(400).json({ message: 'email/password required' });

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email))
      return res.status(400).json({ message: 'Invalid email format' });

    if (password.length < 8 || !/[0-9]/.test(password))
      return res.status(400).json({ message: 'Weak password' });

    const [dup] = await pool.execute('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (dup.length) return res.status(409).json({ message: 'Email already used' });

    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);

    await pool.execute(
      'INSERT INTO users (id,email,password_hash,display_name,role) VALUES (?,?,?,?,?)',
      [id, email, hash, displayName || email.split('@')[0], 'user']
    );

    const access = signAccess({ sub: id, email, role: 'user' });
    const refresh = signRefresh({
      sub: id,
      email,
      role: 'user',
      ver: 1
    });

    await storeRefresh(id, refresh, {
      ua: req.headers['user-agent'],
      ip: req.ip
    });

    const secure = process.env.NODE_ENV === 'production';

    res.cookie('refreshToken', refresh, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.status(201).json({
      accessToken: access,
      refreshToken: process.env.DEV_REFRESH_IN_BODY === 'true' ? refresh : undefined,
      user: {
        id,
        email,
        displayName: displayName || email.split('@')[0],
        role: 'user'
      }
    });
  })
);

// 로그인
app.post(
  '/api/auth/login',
  authLimiter,
  asyncH(async (req, res) => {
    let { email, password } = req.body || {};
    email = String(email || '').trim().toLowerCase();

    const [rows] = await pool.execute('SELECT * FROM users WHERE email=? LIMIT 1', [email]);
    const user = rows[0];

    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    const access = signAccess({
      sub: user.id,
      email: user.email,
      role: user.role
    });
    const refresh = signRefresh({
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: 1
    });

    await storeRefresh(user.id, refresh, {
      ua: req.headers['user-agent'],
      ip: req.ip
    });

    const secure = process.env.NODE_ENV === 'production';

    res.cookie('refreshToken', refresh, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const body = {
      accessToken: access,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role
      }
    };

    if (process.env.DEV_REFRESH_IN_BODY === 'true') body.refreshToken = refresh;

    return res.json(body);
  })
);

// 토큰 리프레시
app.post(
  '/api/auth/refresh',
  authLimiter,
  asyncH(async (req, res) => {
    let refresh = req.cookies?.refreshToken;
    if (!refresh && process.env.DEV_REFRESH_IN_BODY === 'true') {
      refresh = req.headers['x-refresh-token'] || req.body?.refreshToken || null;
    }

    if (!refresh) return res.status(401).json({ message: 'No refresh' });

    if (!(await isRefreshUsable(refresh)))
      return res.status(401).json({ message: 'Revoked/Expired' });

    const payload = verifyRefresh(refresh);

    await revokeRefresh(refresh);

    const access = signAccess({
      sub: payload.sub,
      email: payload.email,
      role: payload.role
    });
    const nextRefresh = signRefresh({
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      ver: (payload.ver || 1) + 1
    });

    await storeRefresh(payload.sub, nextRefresh, {
      ua: req.headers['user-agent'],
      ip: req.ip
    });

    const secure = process.env.NODE_ENV === 'production';

    res.cookie('refreshToken', nextRefresh, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const body = { accessToken: access };
    if (process.env.DEV_REFRESH_IN_BODY === 'true') body.refreshToken = nextRefresh;

    return res.json(body);
  })
);

// 로그아웃
app.post(
  '/api/auth/logout',
  authLimiter,
  asyncH(async (req, res) => {
    let refresh = req.cookies?.refreshToken;
    if (!refresh && process.env.DEV_REFRESH_IN_BODY === 'true') {
      refresh = req.headers['x-refresh-token'] || req.body?.refreshToken || null;
    }

    if (refresh) await revokeRefresh(refresh);

    const secure = process.env.NODE_ENV === 'production';

    res.cookie('refreshToken', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api/auth',
      maxAge: 0
    });

    return res.json({ ok: true });
  })
);

// 내 정보
app.get(
  '/api/auth/me',
  requireAuth,
  asyncH(async (req, res) => {
    const [rows] = await pool.execute(
      'SELECT id,email,display_name,role FROM users WHERE id=? LIMIT 1',
      [req.user.sub]
    );

    const me = rows[0];
    if (!me) return res.status(404).json({ message: 'User not found' });

    return res.json({
      user: {
        id: me.id,
        email: me.email,
        displayName: me.display_name,
        role: me.role
      }
    });
  })
);

// 비밀번호 변경
app.patch(
  '/api/auth/password',
  requireAuth,
  asyncH(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword)
      return res
        .status(400)
        .json({ message: 'currentPassword/newPassword required' });

    if (newPassword.length < 8 || !/[0-9]/.test(newPassword))
      return res.status(400).json({ message: 'weak password' });

    const [rows] = await pool.execute(
      'SELECT password_hash FROM users WHERE id=? LIMIT 1',
      [req.user.sub]
    );
    const user = rows[0];

    if (!user) return res.status(404).json({ message: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ message: 'Invalid current password' });

    const hash = await bcrypt.hash(newPassword, 10);

    await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [
      hash,
      req.user.sub
    ]);

    return res.json({ ok: true });
  })
);

// 프로필 업데이트
app.patch(
  '/api/auth/profile',
  requireAuth,
  asyncH(async (req, res) => {
    let { displayName, email } = req.body || {};

    if (!displayName && !email)
      return res.status(400).json({ message: 'nothing to update' });

    if (typeof displayName === 'string') displayName = displayName.trim();

    if (typeof email === 'string') email = email.trim().toLowerCase();

    const sets = [];
    const args = [];

    if (displayName) {
      if (displayName.length < 2 || displayName.length > 40)
        return res
          .status(400)
          .json({ message: 'displayName must be 2~40 chars' });

      sets.push('display_name=?');
      args.push(displayName);
    }

    if (email) {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(email))
        return res.status(400).json({ message: 'Invalid email format' });

      const [dup] = await pool.execute(
        'SELECT id FROM users WHERE email=? AND id<>? LIMIT 1',
        [email, req.user.sub]
      );

      if (dup.length) return res.status(409).json({ message: 'Email already used' });

      sets.push('email=?');
      args.push(email);
    }

    args.push(req.user.sub);

    const [r] = await pool.execute(
      `UPDATE users SET ${sets.join(', ')} WHERE id=?`,
      args
    );

    if (r.affectedRows === 0)
      return res.status(404).json({ message: 'Not found' });

    const [rows2] = await pool.execute(
      'SELECT id,email,display_name,role FROM users WHERE id=? LIMIT 1',
      [req.user.sub]
    );

    const user2 = rows2[0];

    return res.json({
      user: {
        id: user2.id,
        email: user2.email,
        displayName: user2.display_name,
        role: user2.role
      }
    });
  })
);

// -----------------------------------------------------------------------------
// 9) Sessions
// -----------------------------------------------------------------------------
app.post(
  '/api/sessions',
  requireAuth,
  asyncH(async (req, res) => {
    const { company, jobTitle, score, level, feedback, startedAt, finishedAt } =
      req.body || {};
    if (!company) return res.status(400).json({ message: 'company required' });

    const sAt = startedAt ? new Date(startedAt) : new Date();
    const fAt = finishedAt ? new Date(finishedAt) : null;

    const [r] = await pool.execute(
      `INSERT INTO mock_sessions (user_id, company, job_title, score, level, feedback, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        req.user.sub,
        String(company),
        jobTitle ?? null,
        score ?? null,
        level ?? null,
        feedback ?? null,
        sAt,
        fAt
      ]
    );

    return res.status(201).json({ id: r.insertId });
  })
);

// 최근 세션 목록
app.get(
  '/api/sessions/recent',
  requireAuth,
  asyncH(async (req, res) => {
    let limit = parseInt(String(req.query.limit || '10'), 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    if (limit > 100) limit = 100;

    const sql = `
      SELECT id, company, job_title AS jobTitle, score, level, feedback,
             started_at AS startedAt, finished_at AS finishedAt,
             COALESCE(finished_at, started_at) AS createdAt
        FROM mock_sessions
       WHERE user_id=?
       ORDER BY COALESCE(finished_at, started_at) DESC
       LIMIT ${limit}
    `;

    const [rows] = await pool.execute(sql, [req.user.sub]);
    return res.json({ items: rows });
  })
);

// 세션 목록 페이지네이션
app.get(
  '/api/sessions',
  requireAuth,
  asyncH(async (req, res) => {
    let page = Math.max(parseInt(String(req.query.page || '1'), 10), 1);
    let size = Math.min(
      Math.max(parseInt(String(req.query.size || '10'), 10), 1),
      50
    );
    const offset = (page - 1) * size;

    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM mock_sessions WHERE user_id=?`,
      [req.user.sub]
    );

    const sql = `
      SELECT id, company, job_title AS jobTitle, score, level, feedback,
             started_at AS startedAt, finished_at AS finishedAt,
             COALESCE(finished_at, started_at) AS createdAt
        FROM mock_sessions
       WHERE user_id=?
       ORDER BY COALESCE(finished_at, started_at) DESC
       LIMIT ${size} OFFSET ${offset}
    `;

    const [rows] = await pool.execute(sql, [req.user.sub]);

    return res.json({
      items: rows,
      page,
      size,
      total: cnt,
      totalPages: Math.ceil(cnt / size)
    });
  })
);

// 세션 하나 조회
app.get(
  '/api/sessions/:id',
  requireAuth,
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    const [rows] = await pool.execute(
      `SELECT id, user_id AS userId, company, job_title AS jobTitle, score, level, feedback,
              started_at AS startedAt, finished_at AS finishedAt,
              COALESCE(finished_at, started_at) AS createdAt
         FROM mock_sessions
        WHERE id=? AND user_id=? LIMIT 1`,
      [id, req.user.sub]
    );

    const row = rows[0];
    if (!row) return res.status(404).json({ message: 'Not found' });

    return res.json({ item: row });
  })
);

// 세션 수정
app.patch(
  '/api/sessions/:id',
  requireAuth,
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    const fields = [
      'company',
      'jobTitle',
      'score',
      'level',
      'feedback',
      'startedAt',
      'finishedAt'
    ];
    const payload = {};

    for (const k of fields)
      if (Object.prototype.hasOwnProperty.call(req.body, k))
        payload[k] = req.body[k];

    if (Object.keys(payload).length === 0)
      return res.status(400).json({ message: 'no fields' });

    const sets = [];
    const args = [];

    if ('company' in payload) {
      sets.push('company=?');
      args.push(String(payload.company));
    }
    if ('jobTitle' in payload) {
      sets.push('job_title=?');
      args.push(payload.jobTitle ?? null);
    }
    if ('score' in payload) {
      sets.push('score=?');
      args.push(payload.score ?? null);
    }
    if ('level' in payload) {
      sets.push('level=?');
      args.push(payload.level ?? null);
    }
    if ('feedback' in payload) {
      sets.push('feedback=?');
      args.push(payload.feedback ?? null);
    }
    if ('startedAt' in payload) {
      sets.push('started_at=?');
      args.push(payload.startedAt ? new Date(payload.startedAt) : new Date());
    }
    if ('finishedAt' in payload) {
      sets.push('finished_at=?');
      args.push(payload.finishedAt ? new Date(payload.finishedAt) : null);
    }

    args.push(id, req.user.sub);

    const [r] = await pool.execute(
      `UPDATE mock_sessions SET ${sets.join(', ')} WHERE id=? AND user_id=?`,
      args
    );

    if (r.affectedRows === 0)
      return res.status(404).json({ message: 'Not found' });

    return res.json({ ok: true });
  })
);

// 세션 삭제
app.delete(
  '/api/sessions/:id',
  requireAuth,
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    const [r] = await pool.execute(
      `DELETE FROM mock_sessions WHERE id=? AND user_id=?`,
      [id, req.user.sub]
    );

    if (r.affectedRows === 0)
      return res.status(404).json({ message: 'Not found' });

    return res.json({ ok: true });
  })
);

// -----------------------------------------------------------------------------
// 10) SESSION QUESTIONS
// -----------------------------------------------------------------------------
app.post(
  '/api/sessions/:id/questions/attach',
  requireAuth,
  asyncH(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);

    if (!(await ensureOwnSession(sessionId, req.user.sub)))
      return res.status(404).json({ message: 'Session not found' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const replace = !!req.body?.replace;

    if (!items.length)
      return res.status(400).json({ message: 'items required' });

    if (replace)
      await pool.execute(
        'DELETE FROM session_questions WHERE session_id=? AND user_id=?',
        [sessionId, req.user.sub]
      );

    const [[{ m }]] = await pool.query(
      'SELECT COALESCE(MAX(order_no),0) AS m FROM session_questions WHERE session_id=? AND user_id=?',
      [sessionId, req.user.sub]
    );

    let order = Number(m) || 0;
    const inserted = [];

    for (const it of items) {
      order += 1;
      let text = (it.text ?? '').toString().trim();
      let category = it.category ?? null;
      let questionId = it.questionId ? Number(it.questionId) : null;

      if (!text && questionId) {
        const [qr] = await pool.execute(
          'SELECT text, category FROM questions WHERE id=? LIMIT 1',
          [questionId]
        );

        if (qr[0]) {
          text = qr[0].text;
          if (!category) category = qr[0].category || null;
        }
      }

      if (!text) continue;

      await pool.execute(
        `INSERT IGNORE INTO session_questions (session_id,user_id,question_id,text,category,order_no)
         VALUES (?,?,?,?,?,?)`,
        [sessionId, req.user.sub, questionId, text, category, order]
      );

      inserted.push({
        text,
        category,
        order_no: order,
        question_id: questionId
      });
    }

    return res.status(201).json({ items: inserted });
  })
);

// ---------------- LIST QUESTIONS ----------------
app.get(
  "/api/sessions/:id/questions",
  requireAuth,
  asyncH(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);

    if (!(await ensureOwnSession(sessionId, req.user.sub))) {
      return res.status(404).json({ message: "Session not found" });
    }

    const [rows] = await pool.execute(
      `SELECT *
         FROM session_questions
        WHERE session_id=? AND user_id=?
        ORDER BY order_no ASC, id ASC`,
      [sessionId, req.user.sub]
    );

    const items = rows.map((r) => ({
      id: r.id,
      questionId: r.question_id,
      text: r.text,
      category: r.category,
      orderNo: r.order_no,

      answer: r.answer,
      score: r.score,
      feedback: r.feedback,

      summary_interviewer: r.summary_interviewer,
      summary_coach: r.summary_coach,

      strengths: safeJson(r.strengths, []),
      gaps: safeJson(r.gaps, []),
      adds: safeJson(r.adds, []),
      pitfalls: safeJson(r.pitfalls, []),

      next: safeJson(r.next_steps, []),
      polished: r.polished,

      keywords: safeJson(r.keywords, []),
      follow_up_questions: safeJson(r.follow_up, []),
      chart: safeJson(r.chart, {}),

      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));

    return res.json({ items });
  })
);

// 질문 단건 업데이트
app.patch(
  "/api/sessions/:id/questions/:sqid",
  requireAuth,
  asyncH(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const sqid = parseInt(req.params.sqid, 10);

    if (!(await ensureOwnSession(sessionId, req.user.sub)))
      return res.status(404).json({ message: "Session not found" });

    const sets = [];
    const args = [];

    if ("answer" in req.body) {
      sets.push("answer=?");
      args.push(req.body.answer ?? null);
    }

    // 🔥 score는 숫자일 때만 반영
    if (
      Object.prototype.hasOwnProperty.call(req.body, "score") &&
      typeof req.body.score === "number" &&
      Number.isFinite(req.body.score)
    ) {
      sets.push("score=?");
      args.push(req.body.score);
    }

    if ("feedback" in req.body) {
      sets.push("feedback=?");
      args.push(req.body.feedback ?? null);
    }
    if ("durationMs" in req.body) {
      sets.push("duration_ms=?");
      args.push(req.body.durationMs ?? null);
    }

    if (!sets.length)
      return res.status(400).json({ message: "no fields" });

    args.push(sessionId, req.user.sub, sqid);

    const [r] = await pool.execute(
      `UPDATE session_questions SET ${sets.join(", ")}
        WHERE session_id=? AND user_id=? AND id=?`,
      args
    );

    if (r.affectedRows === 0)
      return res.status(404).json({ message: "Not found" });

    return res.json({ ok: true });
  })
);

// -----------------------------------------------------------------------------
// 11) RANDOM SESSION START
// -----------------------------------------------------------------------------
app.post(
  '/api/companies/:company/sessions/start',
  requireAuth,
  asyncH(async (req, res) => {
    const company = String(req.params.company || '').toLowerCase();
    const count = Math.max(
      1,
      Math.min(200, Number(req.body?.count || process.env.DEFAULT_QUESTION_COUNT || 10))
    );
    const jobTitle = req.body?.jobTitle ?? null;

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [ins] = await conn.execute(
        `INSERT INTO mock_sessions (user_id, company, job_title, started_at)
         VALUES (?,?,?,NOW())`,
        [req.user.sub, company, jobTitle]
      );

      const sessionId = ins.insertId;

      const [qs] = await conn.query(
        `SELECT q.id, q.text, q.category
           FROM questions q
          WHERE q.company=?
          ORDER BY RAND()
          LIMIT ?`,
        [company, count]
      );

      let order = 0;

      for (const q of qs) {
        order += 1;
        await conn.execute(
          `INSERT IGNORE INTO session_questions
             (session_id,user_id,question_id,text,category,order_no)
           VALUES (?,?,?,?,?,?)`,
          [sessionId, req.user.sub, q.id, q.text, q.category || null, order]
        );
      }

      await conn.commit();

      const [rows] = await pool.execute(
        `SELECT id, question_id AS questionId, text, category, order_no AS orderNo
           FROM session_questions
          WHERE session_id=? AND user_id=?
          ORDER BY order_no ASC, id ASC`,
        [sessionId, req.user.sub]
      );

      return res.status(201).json({
        sessionId,
        items: rows
      });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  })
);
// -----------------------------------------------------------------------------
// 12) AI GRADE (improvements는 DB에 저장 안 함)
// -----------------------------------------------------------------------------
app.post(
  "/api/sessions/:id/questions/:sqid/grade",
  requireAuth,
  asyncH(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const sqid = parseInt(req.params.sqid, 10);
    const bodyAnswer = (req.body?.answer || "").toString();

    if (!(await ensureOwnSession(sessionId, req.user.sub))) {
      return res.status(404).json({ message: "Session not found" });
    }

    // 질문 + 회사/직무 정보 가져오기 (mock_sessions 기준)
    const [rows] = await pool.execute(
      `SELECT sq.*, s.company, s.job_title
         FROM session_questions sq
         JOIN mock_sessions s ON s.id = sq.session_id
        WHERE sq.id=? AND sq.session_id=? AND sq.user_id=?`,
      [sqid, sessionId, req.user.sub]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ message: "Question not found" });
    }

    const answer = bodyAnswer.trim() || row.answer || "";

    // OpenAI 호출
    const { data, feedbackText: rawFeedback } = await gradeAnswer({
      company: row.company,
      jobTitle: row.job_title,
      question: row.text,
      answer,
    });

    // -----------------------------
    // 점수 계산 (0~10 → soften → 0~100)
    // -----------------------------
    const scoresRaw = data.scores || {};
    const parts10 = [
      scoresRaw.structure,
      scoresRaw.specificity,
      scoresRaw.logic,
      scoresRaw.tech_depth,
      scoresRaw.risk,
    ].map((v) => soften10(v));

    const avg10 =
      parts10.reduce((a, b) => a + b, 0) / Math.max(1, parts10.length);

    const score = Math.max(0, Math.min(100, Math.round(avg10 * 10))); // 0~100
    const grade = gradeFromScore(score);

    // chart 정규화 (0~100 스케일)
    const chartNorm = normalizeChartFromAI(data.chart, scoresRaw);

    // improvements → tips 로 추출
    const tips = Array.isArray(data.improvements)
      ? data.improvements
          .map((im) => (im && im.reason ? String(im.reason) : ""))
          .filter(Boolean)
      : [];

    const aiPayload = {
      score,
      grade,
      summary_interviewer: data.summary_interviewer || "",
      summary_coach: data.summary_coach || "",
      strengths: data.strengths || [],
      gaps: data.gaps || [],
      adds: data.adds || [],
      pitfalls: data.pitfalls || [],
      next: data.next || [],
      tips,
      keywords: data.keywords || [],
      category: data.category || "general",
      polished: data.polished || "",
      chart: chartNorm,
      follow_up_questions: data.follow_up_questions || [],
    };

    // -----------------------------
    // 여기서 "맛있는" feedback 텍스트를 직접 조립
    // -----------------------------
    const lines = [];

    // 1) 총점 / 등급
    lines.push(`총점: ${score}점 (등급 ${grade})`);

    // 2) 핵심 요약 (인터뷰어 요약 > 코치 요약 > rawFeedback 순으로 사용)
    const coreSummary =
      aiPayload.summary_interviewer ||
      aiPayload.summary_coach ||
      rawFeedback ||
      "";
    if (coreSummary) {
      lines.push(`핵심 요약: ${coreSummary}`);
    }

    // 3) 핵심 키워드
    if (aiPayload.keywords && aiPayload.keywords.length) {
      lines.push(
        `핵심 키워드: ${aiPayload.keywords.slice(0, 8).join(", ")}`
      );
    }

    // 불릿 섹션 도우미
    const makeBullet = (title, arr) => {
      if (!arr || !arr.length) return null;
      return `${title}\n- ${arr.join("\n- ")}`;
    };

    const bulletBlocks = [
      makeBullet("강점", aiPayload.strengths),
      makeBullet("개선 포인트", aiPayload.gaps),
      makeBullet("위험 요소", aiPayload.pitfalls),
      makeBullet("다음 단계", aiPayload.next),
      makeBullet(
        "예상 꼬리질문",
        aiPayload.follow_up_questions.map((q) =>
          typeof q === "string" ? q : q.question || ""
        ).filter(Boolean)
      ),
    ].filter(Boolean);

    lines.push(...bulletBlocks);

    const feedbackText = lines.join("\n\n");

    // 🔥 DB 저장 (improvements는 저장 X)
    await pool.execute(
      `UPDATE session_questions
          SET answer = ?,
              score = ?,
              feedback = ?,
              chart = ?,
              summary_interviewer = ?,
              follow_up = ?,
              summary_coach = ?,
              category = COALESCE(?, category),
              strengths = ?,
              gaps = ?,
              adds = ?,
              pitfalls = ?,
              next_steps = ?,
              polished = ?,
              keywords = ?
        WHERE id=? AND session_id=? AND user_id=?`,
      [
        answer,
        score,
        feedbackText, // ← 우리가 조립한 "맛있는" 텍스트를 저장
        JSON.stringify(chartNorm || {}),
        aiPayload.summary_interviewer,
        JSON.stringify(aiPayload.follow_up_questions || []),
        aiPayload.summary_coach,
        aiPayload.category,
        JSON.stringify(aiPayload.strengths || []),
        JSON.stringify(aiPayload.gaps || []),
        JSON.stringify(aiPayload.adds || []),
        JSON.stringify(aiPayload.pitfalls || []),
        JSON.stringify(aiPayload.next || []),
        aiPayload.polished || "",
        JSON.stringify(aiPayload.keywords || []),
        sqid,
        sessionId,
        req.user.sub,
      ]
    );

    console.log("=== AI RESPONSE (raw) ===");
    console.dir(data, { depth: null });
    console.log("=== FEEDBACK TEXT (stored) ===\n" + feedbackText);

    return res.json({ ok: true, ai: aiPayload });
  })
);

// -----------------------------------------------------------------------------
// 13) FINISH SESSION
// -----------------------------------------------------------------------------
app.post(
  '/api/sessions/:id/finish',
  requireAuth,
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (!(await ensureOwnSession(id, req.user.sub)))
      return res.status(404).json({ message: 'Session not found' });

    await pool.execute(
      `UPDATE mock_sessions
          SET finished_at=COALESCE(finished_at, NOW())
        WHERE id=? AND user_id=?`,
      [id, req.user.sub]
    );

    const [[row]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN answer IS NOT NULL AND answer <> '' THEN 1 ELSE 0 END)
           AS answered,
         SUM(CASE WHEN score IS NOT NULL THEN score ELSE 0 END)
           AS scoreSum,
         AVG(score) AS avgScore
       FROM session_questions
      WHERE session_id=? AND user_id=?`,
      [id, req.user.sub]
    );

    const [[dur]] = await pool.query(
      `SELECT COALESCE(SUM(duration_ms),0) AS dur
         FROM session_questions
        WHERE session_id=? AND user_id=?`,
      [id, req.user.sub]
    );

    const avg = row.avgScore != null ? Math.round(Number(row.avgScore)) : null;

    const level =
      avg != null
        ? avg >= 90
          ? 'S'
          : avg >= 80
          ? 'A'
          : avg >= 70
          ? 'B'
          : avg >= 60
          ? 'C'
          : avg >= 50
          ? 'D'
          : 'F'
        : null;

    await pool.execute(
      `UPDATE mock_sessions
          SET score=?, level=?
        WHERE id=? AND user_id=?`,
      [avg, level, id, req.user.sub]
    );

    return res.json({
      ok: true,
      summary: {
        total: Number(row.total || 0),
        answered: Number(row.answered || 0),
        score: row.scoreSum != null ? Number(row.scoreSum) : null,
        avgScore:
          row.avgScore != null ? Math.round(Number(row.avgScore)) : null,
        durationMs: Number(dur.dur || 0)
      }
    });
  })
);

// 세션 요약 조회
app.get(
  '/api/sessions/:id/summary',
  requireAuth,
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (!(await ensureOwnSession(id, req.user.sub)))
      return res.status(404).json({ message: 'Session not found' });

    const [[row]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN answer IS NOT NULL AND answer <> '' THEN 1 ELSE 0 END)
           AS answered,
         AVG(score) AS avgScore
       FROM session_questions
      WHERE session_id=? AND user_id=?`,
      [id, req.user.sub]
    );

    const [[dur]] = await pool.query(
      `SELECT COALESCE(SUM(duration_ms),0) AS dur
         FROM session_questions
        WHERE session_id=? AND user_id=?`,
      [id, req.user.sub]
    );

    const [by] = await pool.query(
      `SELECT category,
              COUNT(*) AS count,
              AVG(score) AS avgScore
         FROM session_questions
        WHERE session_id=? AND user_id=?
        GROUP BY category`,
      [id, req.user.sub]
    );

    return res.json({
      summary: {
        total: Number(row.total || 0),
        answered: Number(row.answered || 0),
        avgScore:
          row.avgScore != null ? Math.round(Number(row.avgScore)) : null,
        durationMs: Number(dur.dur || 0),
        byCategory: by.map((r) => ({
          category: r.category,
          count: Number(r.count || 0),
          avgScore:
            r.avgScore != null ? Math.round(Number(r.avgScore)) : null
        }))
      }
    });
  })
);

// -----------------------------------------------------------------------------
// 14) INTERVIEW ROUTER (optional)
// -----------------------------------------------------------------------------
let interviewRouter;
try {
  interviewRouter = require('./interview');
} catch {
  interviewRouter = express.Router();
}

app.use('/api/interview', requireAuth, interviewRouter);

// -----------------------------------------------------------------------------
// 15) 404 & ERROR HANDLER
// -----------------------------------------------------------------------------
app.use((req, res) => {
  return res.status(404).json({
    message: 'not found',
    requestId: req.id
  });
});

app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  return res.status(500).json({
    message: 'server error',
    requestId: req.id
  });
});

// -----------------------------------------------------------------------------
// 16) SERVER START + GRACEFUL SHUTDOWN
// -----------------------------------------------------------------------------
function listLocalAccessUrls(port) {
  const nets = os.networkInterfaces();
  const addrs = [];

  Object.values(nets).forEach((ifaces) => {
    (ifaces || []).forEach((it) => {
      if (it.family === 'IPv4' && !it.internal) {
        addrs.push(`http://${it.address}:${port}`);
      }
    });
  });

  return addrs;
}

const server = app.listen(PORT, HOST, async () => {
  try {
    const [r] = await pool.query('SELECT 1 AS ok');
    console.log('MySQL 연결 성공', r[0]);
  } catch (e) {
    console.error('MySQL 연결 실패', e.message);
  }

  console.log('InterviewMon API listening:');
  console.log(` - local: http://localhost:${PORT}`);
  listLocalAccessUrls(PORT).forEach((u) => console.log(` - LAN:   ${u}`));
});

function shutdown(sig) {
  console.log(`\n[${sig}] shutting down...`);
  server.close(async () => {
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
