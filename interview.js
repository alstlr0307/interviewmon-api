// api/interview.js
const express = require('express');
const { pool } = require('./db');

const router = express.Router();
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/interview/questions
 * Query:
 *  - scope: 'all' | 'common' | 'company' (default 'all')
 *  - company: scope='company' 일 때 회사 키
 *  - take: 반환 개수 (기본 12, 최대 100)
 *  - shuffle: 0|1 (랜덤)
 *  - lang, jobRole, seniority, category, tag, q(검색)
 * Response: { items: [{ id, q, category }] }
 */
router.get('/questions', asyncH(async (req, res) => {
  let {
    scope = 'all', company, take = 12, shuffle = 0, lang = 'ko',
    jobRole, seniority, category, tag, q
  } = req.query;

  take = Math.max(1, Math.min(100, Number(take)));
  shuffle = String(shuffle) === '1';

  const where = [];
  const args = [];

  if (lang)      { where.push('lang = ?'); args.push(lang); }
  if (jobRole)   { where.push('job_role = ?'); args.push(jobRole); }
  if (seniority) { where.push('seniority = ?'); args.push(seniority); }
  if (category)  { where.push('category = ?'); args.push(category); }
  if (tag)       { where.push('JSON_CONTAINS(tags, JSON_QUOTE(?))'); args.push(tag); }
  if (q)         { where.push('text LIKE ?'); args.push(`%${q}%`); }

  const s = String(scope || 'all').toLowerCase();
  if (s === 'common') {
    where.push('company IS NULL');
  } else if (s === 'company') {
    if (!company) return res.status(400).json({ message: 'company required' });
    where.push('(company IS NULL OR company = ?)');
    args.push(String(company).toLowerCase());
  }

  const orderBy = shuffle ? 'ORDER BY RAND()' : 'ORDER BY id DESC';
  const sql = `
    SELECT id, text AS q, category
      FROM questions
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ${orderBy}
     LIMIT ?
  `;
  args.push(take);

  const [rows] = await pool.query(sql, args);
  res.json({ items: rows });
}));

module.exports = router;
