// api/token.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('./db');

const {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  ACCESS_TTL = '15m',
  REFRESH_TTL = '7d',
} = process.env;

if (!JWT_ACCESS_SECRET || !JWT_REFRESH_SECRET) {
  console.warn('[token] Missing JWT secrets. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in .env');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function signAccess(payload, opts = {}) {
  return jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: ACCESS_TTL, ...opts });
}
function signRefresh(payload, opts = {}) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL, ...opts });
}
function verifyAccess(token) { return jwt.verify(token, JWT_ACCESS_SECRET); }
function verifyRefresh(token) { return jwt.verify(token, JWT_REFRESH_SECRET); }

async function storeRefresh(userId, refreshToken, meta = {}) {
  const payload = verifyRefresh(refreshToken);
  const tokenHash = sha256(refreshToken);
  const issuedAt  = new Date(payload.iat * 1000);
  const expiresAt = new Date(payload.exp * 1000);

  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, issued_at, expires_at, user_agent, ip)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       issued_at = VALUES(issued_at),
       expires_at = VALUES(expires_at),
       user_agent = VALUES(user_agent),
       ip = VALUES(ip)`,
    [userId, tokenHash, issuedAt, expiresAt, meta.ua || null, meta.ip || null]
  );
}

async function isRefreshUsable(refreshToken) {
  try {
    const payload = verifyRefresh(refreshToken);
    const tokenHash = sha256(refreshToken);
    const [rows] = await pool.execute(
      `SELECT id, revoked_at, expires_at
         FROM refresh_tokens
        WHERE user_id=? AND token_hash=?
        ORDER BY expires_at DESC, id DESC
        LIMIT 1`,
      [payload.sub, tokenHash]
    );
    const row = rows[0];
    if (!row) return false;
    if (row.revoked_at) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

async function revokeRefresh(refreshToken) {
  try {
    const payload = verifyRefresh(refreshToken);
    const tokenHash = sha256(refreshToken);
    await pool.execute(
      `UPDATE refresh_tokens
          SET revoked_at = NOW()
        WHERE user_id=? AND token_hash=? AND revoked_at IS NULL`,
      [payload.sub, tokenHash]
    );
  } catch {}
}

module.exports = {
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  storeRefresh,
  revokeRefresh,
  isRefreshUsable,
  sha256,
};
