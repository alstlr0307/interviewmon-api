// api/sessionAnswers.js
const express = require('express');
const { pool } = require('./db');

const router = express.Router({ mergeParams: true });

/**
 * upsert 답변
 * body: { questionId, answerText }
 */
router.post('/', async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { questionId, answerText } = req.body || {};
    if (!sessionId || !questionId) return res.status(400).json({ message: 'sessionId/questionId required' });

    await pool.query(`
      INSERT INTO session_answers (session_id, question_id, answer_text)
      VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE answer_text=VALUES(answer_text), updated_at=NOW()
    `, [sessionId, questionId, answerText ?? null]);

    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * 세션 답변 조회(질문과 조인)
 */
router.get('/', async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const [rows] = await pool.query(`
      SELECT
        sq.order_no AS orderNo,
        sq.question_id AS questionId,
        sq.text AS questionText,
        sa.answer_text AS answerText,
        sa.eval_score AS evalScore,
        sa.eval_breakdown AS evalBreakdown,
        sa.ai_advice AS aiAdvice
      FROM session_questions sq
      LEFT JOIN session_answers sa
        ON sa.session_id=sq.session_id AND sa.question_id=sq.question_id
      WHERE sq.session_id=? AND sq.user_id=?
      ORDER BY sq.order_no ASC
    `, [sessionId, req.user.sub]);

    res.json({ items: rows });
  } catch (e) { next(e); }
});

/**
 * (임시) 간단 채점: 답변 길이에 따라 0~100
 * 실제로는 여기에서 OpenAI/Claude 등을 호출해 점수/피드백을 넣으면 된다.
 */
router.post('/evaluate', async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const [rows] = await pool.query(`
      SELECT question_id, COALESCE(answer_text, '') AS a
      FROM session_answers
      WHERE session_id=?
    `, [sessionId]);

    let total = 0, n = 0;
    for (const r of rows) {
      const len = r.a.trim().length;
      const score = Math.max(0, Math.min(100, Math.round(len / 4))); // 매우 단순 스텁
      total += score; n++;

      await pool.query(`
        UPDATE session_answers
        SET eval_score=?, eval_breakdown=JSON_OBJECT('len', ?), ai_advice=JSON_OBJECT('tip','근거를 수치/사례로 보강해 주세요.')
        WHERE session_id=? AND question_id=?
      `, [score, len, sessionId, r.question_id]);
    }

    const avg = n ? Math.round(total / n) : 0;

    // 세션 헤더에도 반영
    await pool.query(`
      UPDATE mock_sessions SET score=?, level=?, finished_at=COALESCE(finished_at, NOW())
      WHERE id=? AND user_id=?
    `, [avg, avg >= 70 ? 'senior' : avg >= 40 ? 'mid' : 'junior', sessionId, req.user.sub]);

    res.json({ score: avg, count: n });
  } catch (e) { next(e); }
});

module.exports = router;
