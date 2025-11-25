// ai.js — Interviewmon AI Engine v2.0
// 완전 강화된 실전 공격형 피드백 + JSON 스키마 안정화 버전

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =============================================================
 *  카테고리 자동 분류
 * ============================================================= */
function pickCategory(question = "") {
  const q = question.toLowerCase();
  if (/(lead|mentor|conflict|communication)/.test(q)) return "behavior";
  if (/(perf|latency|qps|cpu|gpu|cache|optimi)/.test(q)) return "tech";
  if (/(archi|design|scale|traffic|db|service)/.test(q)) return "architecture";
  if (/(incident|failure|postmortem)/.test(q)) return "incident";
  if (/(data|metric|ab|experiment)/.test(q)) return "data";
  return "general";
}

function gradeFromScore(s) {
  if (s >= 90) return "S";
  if (s >= 80) return "A";
  if (s >= 70) return "B";
  if (s >= 60) return "C";
  if (s >= 50) return "D";
  return "F";
}

/* =============================================================
 *  JSON 유틸
 * ============================================================= */
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function toStringArray(v) {
  return toArray(v)
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x.text === "string") return x.text.trim();
      return "";
    })
    .filter(Boolean);
}

function normalizePitfalls(v) {
  return toArray(v)
    .map((p) => {
      if (!p) return null;
      if (typeof p === "string") return { text: p.trim(), level: null };

      const text = typeof p.text === "string" ? p.text.trim() : null;
      const level =
        typeof p.level === "number" && Number.isFinite(p.level)
          ? p.level
          : null;

      return text ? { text, level } : null;
    })
    .filter(Boolean);
}

const safeJSON = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/* =============================================================
 *  fallback
 * ============================================================= */
function fallbackResult(question) {
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
    logic_flaws: [],
    missing_details: [],
    risk_points: [],
    follow_up_questions: [],
    improvements: [],
    polished_answers: { advanced: "" },
    summary_interviewer: "",
    summary_coach: "",
    keywords: [],
    category: pickCategory(question),
  };
}

/* =============================================================
 *  Main grading
 * ============================================================= */
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const systemPrompt = `
당신은 실리콘밸리 엘리트 면접관이다.
당신은 매우 논리적이며, 공격적이고, 증거 기반 피드백을 제공한다.
지원자의 답변에서 허점을 찾아내는 것이 최우선 목표다.

규칙:
1) 근거 없는 주장, 모호한 표현 → 즉시 지적
2) 행동(Action)이 실제 실행인지 검증
3) 성과(Result)에 수치·증거 없으면 날카롭게 비판
4) 기술 깊이가 부족하면 어떤 부분이 얕은지 명확히 설명
5) “했다”라고 말하는 부분 증거 요구
6) 논리적 비약/과장 → 문장 단위로 콕 집어서 지적
7) STAR 구조 부족 시 단계별 설명
8) 실제 면접 꼬리질문 + 왜 물어보는지 이유 필수
9) 공격적이지만 예의는 지킴
JSON만 출력한다.
`;

  const userPrompt = `
아래 JSON 스키마에 100% 맞춰 작성하십시오.
필드 추가 금지. 누락 금지.

{
  "score_overall": 0,
  "scores": {
    "structure": 0,
    "specificity": 0,
    "logic": 0,
    "tech_depth": 0,
    "risk": 0
  },
  "strengths": [],
  "gaps": [],
  "logic_flaws": [
    { "text": "", "why": "", "fix": "" }
  ],
  "missing_details": [
    { "text": "", "why_needed": "" }
  ],
  "risk_points": [],
  "follow_up_questions": [
    { "question": "", "reason": "" }
  ],
  "improvements": [
    { "before": "", "after": "", "reason": "" }
  ],
  "polished_answers": {
    "advanced": ""
  },
  "summary_interviewer": "",
  "summary_coach": "",
  "keywords": []
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
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    raw = resp.choices[0].message.content;
  } catch (e) {
    console.error("AI ERROR:", e);
    return {
      data: fallbackResult(question),
      feedbackText: "⚠️ AI 사용량 초과 또는 내부 오류"
    };
  }

  const parsed = safeJSON(raw) || fallbackResult(question);

  const score = Number(parsed.score_overall) || 0;
  const grade = gradeFromScore(score);

  const data = {
    score,
    grade,
    category: pickCategory(question),
    summary_interviewer: parsed.summary_interviewer || "",
    summary_coach: parsed.summary_coach || "",
    strengths: toStringArray(parsed.strengths),
    gaps: toStringArray(parsed.gaps),
    adds: [], // 삭제됨
    pitfalls: normalizePitfalls(parsed.risk_points),
    next: [], // 필요 시 확장
    keywords: toStringArray(parsed.keywords),
    polished: parsed.polished_answers?.advanced || "",
    chart: parsed.scores || {},
    follow_up_questions: parsed.follow_up_questions || [],
  };

  const lines = [];
  if (data.summary_interviewer)
    lines.push("면접관 요약: " + data.summary_interviewer);
  if (data.summary_coach)
    lines.push("코치 요약: " + data.summary_coach);

  return { data, feedbackText: lines.join("\n") };
}

module.exports = { gradeAnswer };
