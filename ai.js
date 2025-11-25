// ai.js — InterviewMon AI Engine v2.1
// 모든 JSON 구조를 100% 보정하고 undefined → null 변환

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =============================================================
 * Safe utilities — undefined 절대 금지
 * ============================================================= */
const safe = (v, fb = null) => (v === undefined ? fb : v);

const safeStr = (v) => (typeof v === "string" ? v : "");
const safeStrArr = (v) =>
  !v
    ? []
    : Array.isArray(v)
    ? v.map(safeStr).filter(Boolean)
    : [safeStr(v)];

function safeFollowUps(arr) {
  if (!arr) return [];
  return arr.map((x) => {
    if (!x) return { question: "", reason: "" };
    if (typeof x === "string") return { question: x, reason: "" };

    return {
      question: safeStr(x.question),
      reason: safeStr(x.reason),
    };
  });
}

function safeMissingDetails(arr) {
  if (!arr) return [];
  return arr.map((x) => ({
    text: safeStr(x?.text),
    why_needed: safeStr(x?.why_needed),
  }));
}

function safeLogicFlaws(arr) {
  if (!arr) return [];
  return arr.map((x) => ({
    text: safeStr(x?.text),
    why: safeStr(x?.why),
    fix: safeStr(x?.fix),
  }));
}

function safeImprovements(arr) {
  if (!arr) return [];
  return arr.map((x) => ({
    before: safeStr(x?.before),
    after: safeStr(x?.after),
    reason: safeStr(x?.reason),
  }));
}

function normalizePitfalls(v) {
  if (!v) return [];
  return v
    .map((p) => {
      if (!p) return null;

      if (typeof p === "string")
        return { text: p.trim(), level: null };

      const text = safeStr(p.text);
      const level =
        typeof p.level === "number" && Number.isFinite(p.level)
          ? p.level
          : null;

      return text ? { text, level } : null;
    })
    .filter(Boolean);
}

const safeChart = (scores) => ({
  structure: Number(scores?.structure ?? 0),
  specificity: Number(scores?.specificity ?? 0),
  logic: Number(scores?.logic ?? 0),
  tech_depth: Number(scores?.tech_depth ?? 0),
  risk: Number(scores?.risk ?? 0),
});

const safeJSON = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/* =============================================================
 * fallback
 * ============================================================= */
function fallback(question) {
  return {
    score_overall: 0,
    scores: {
      structure: 0,
      specificity: 0,
      logic: 0,
      tech_depth: 0,
      risk: 0,
    },
    strengths: [],
    gaps: [],
    adds: [],
    pitfalls: [],
    next: [],
    logic_flaws: [],
    missing_details: [],
    risk_points: [],
    improvements: [],
    polished_answers: { advanced: "" },
    summary_interviewer: "",
    summary_coach: "",
    keywords: [],
    follow_up_questions: [],
    category: "general",
  };
}

/* =============================================================
 * Main grading
 * ============================================================= */
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const system = `
당신은 실전 기술 면접관이다.
모든 답변에서 허점을 찾아내고 근거 기반 비판을 제공한다.
JSON만 출력한다.
`;

  const user = `
JSON 스키마를 100% 준수해야 한다. 필드 누락 금지. 추가 금지.

{
  "score_overall": 0,
  "scores": { "structure": 0, "specificity": 0, "logic": 0, "tech_depth": 0, "risk": 0 },

  "strengths": [],
  "gaps": [],
  "adds": [],
  "pitfalls": [],
  "next": [],

  "logic_flaws": [{ "text": "", "why": "", "fix": "" }],
  "missing_details": [{ "text": "", "why_needed": "" }],
  "risk_points": [],
  "improvements": [{ "before": "", "after": "", "reason": "" }],

  "polished_answers": { "advanced": "" },

  "follow_up_questions": [{ "question": "", "reason": "" }],

  "summary_interviewer": "",
  "summary_coach": "",
  "keywords": [],
  "category": "general"
}

질문: ${question}
직무: ${jobTitle}
기업: ${company}

지원자 답변:
${answer}
`;

  let raw;
  try {
    const resp = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    raw = resp.choices[0].message.content;
  } catch (e) {
    console.error("AI ERROR:", e);
    return { data: fallback(question), feedbackText: "AI 오류" };
  }

  const parsed = safeJSON(raw) || fallback(question);

  /* =============================================================
   * Final data — undefined 완전 제거 버전
   * ============================================================= */
  const data = {
    score_overall: Number(parsed.score_overall ?? 0),
    scores: safe(parsed.scores, {}),

    strengths: safeStrArr(parsed.strengths),
    gaps: safeStrArr(parsed.gaps),
    adds: safeStrArr(parsed.adds),
    pitfalls: normalizePitfalls(parsed.pitfalls),

    next: safeStrArr(parsed.next),

    logic_flaws: safeLogicFlaws(parsed.logic_flaws),
    missing_details: safeMissingDetails(parsed.missing_details),
    risk_points: safeStrArr(parsed.risk_points),
    improvements: safeImprovements(parsed.improvements),

    polished: safeStr(parsed.polished_answers?.advanced),

    follow_up_questions: safeFollowUps(parsed.follow_up_questions),

    keywords: safeStrArr(parsed.keywords),
    summary_interviewer: safeStr(parsed.summary_interviewer),
    summary_coach: safeStr(parsed.summary_coach),
    category: safeStr(parsed.category),

    chart: safeChart(parsed.scores),
  };

  const lines = [];
  if (data.summary_interviewer)
    lines.push("면접관 요약: " + data.summary_interviewer);
  if (data.summary_coach)
    lines.push("코치 요약: " + data.summary_coach);

  return { data, feedbackText: lines.join("\n") };
}

module.exports = { gradeAnswer };
