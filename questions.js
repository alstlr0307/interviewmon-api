// api/questions.js
const express = require('express');
const { pool } = require('./db');

const router = express.Router();

// 목록 (필터: company/jobRole/category/seniority/lang/tag 검색어 q)
router.get('/', async (req, res, next) => {
  try {
    const {
      company, jobRole, category, seniority, lang = 'ko', tag, q, page = 1, size = 50,
    } = req.query;

    const where = [];
    const args = [];

    if (company)   { where.push('company = ?');        args.push(company); }
    if (jobRole)   { where.push('job_role = ?');       args.push(jobRole); }
    if (category)  { where.push('category = ?');       args.push(category); }
    if (seniority) { where.push('seniority = ?');      args.push(seniority); }
    if (lang)      { where.push('lang = ?');           args.push(lang); }
    if (tag)       { where.push('JSON_CONTAINS(tags, JSON_QUOTE(?))'); args.push(tag); }
    if (q)         { where.push('text LIKE ?');        args.push(`%${q}%`); }

    const base = `
      FROM questions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
    `;

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const s = Math.min(Math.max(parseInt(size, 10) || 50, 1), 200);
    const off = (p - 1) * s;

    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt ${base}`, args);
    const [rows] = await pool.query(`SELECT * ${base} LIMIT ? OFFSET ?`, [...args, s, off]);

    res.json({ items: rows, page: p, size: s, total: cnt, totalPages: Math.ceil(cnt / s) });
  } catch (e) { next(e); }
});

// 단건 조회
router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM questions WHERE id=?', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ message: 'Not found' });
    res.json({ item: row });
  } catch (e) { next(e); }
});

// (옵션) 관리자 전용 upsert/remove
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'forbidden' });
  next();
}

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { company, jobRole, category, seniority, lang = 'ko', tags = [], text } = req.body || {};
    if (!text) return res.status(400).json({ message: 'text required' });
    const [r] = await pool.query(`
      INSERT INTO questions (company, job_role, category, seniority, lang, tags, text)
      VALUES (?,?,?,?,?, CAST(? AS JSON), ?)
    `, [company ?? null, jobRole ?? null, category ?? null, seniority ?? null, lang, JSON.stringify(tags), text]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = ['company','jobRole','category','seniority','lang','tags','text'];
    const sets = []; const args = [];
    for (const k of fields) if (k in req.body) {
      if (k === 'jobRole')   { sets.push('job_role=?');  args.push(req.body[k]); }
      else if (k === 'tags') { sets.push('tags=CAST(? AS JSON)'); args.push(JSON.stringify(req.body[k] ?? [])); }
      else                   { sets.push(`${k}=?`);      args.push(req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ message: 'no fields' });
    args.push(req.params.id);
    const [r] = await pool.query(`UPDATE questions SET ${sets.join(', ')} WHERE id=?`, args);
    if (!r.affectedRows) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM questions WHERE id=?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
