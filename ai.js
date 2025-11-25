// ai.js — Interviewmon AI Engine v2.2
// 기존 v2.0 기반 + Result/AiFeedback 호환 구조 확장 + JSON 스키마 정합성 강화

const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function pickCategory(q = "") {
  q = q.toLowerCase();
  if (/(lead|mentor|conflict|communication)/.test(q)) return "behavior";
  if (/(perf|latency|qps|cpu|gpu|cache|optimi)/.test(q)) return "tech";
  if (/(archi|design|scale|traffic|db|service)/.test(q)) return "architecture";
  if (/(incident|failure|postmortem)/.test(q)) return "incident";
  if (/(data|metric|ab|experiment)/.test(q)) return "data";
  return "general";
}

function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

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
      const text = p.text?.trim() ?? null;
      const level = Number.isFinite(p.level) ? p.level : null;
      return text ? { text, level } : null;
    })
    .filter(Boolean);
}

function safeJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fallbackResult(q) {
  return {
    score_overall: 0,
    scores: { structure: 0, specificity: 0, logic: 0, tech_depth: 0, risk: 0 },
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
    category: pickCategory(q),
  };
}

async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const systemPrompt = `
당신은 실리콘밸리 최고 수준의 면접관이다.
답변을 논리적·구조적으로 채점하고, JSON으로만 출력한다.
`;

  const userPrompt = `
아래 JSON 스키마 형식으로만 작성하십시오.

{
  "score_overall": 0,
  "scores": { "structure": 0, "specificity": 0, "logic": 0, "tech_depth": 0, "risk": 0 },
  "strengths": [],
  "gaps": [],
  "logic_flaws": [{ "text": "", "why": "", "fix": "" }],
  "missing_details": [{ "text": "", "why_needed": "" }],
  "risk_points": [],
  "follow_up_questions": [{ "question": "", "reason": "" }],
  "improvements": [{ "before": "", "after": "", "reason": "" }],
  "polished_answers": { "advanced": "" },
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
    const r = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    raw = r.choices[0].message.content;
  } catch (e) {
    console.error("AI ERROR:", e);
    return { data: fallbackResult(question), feedbackText: "⚠️ AI 응답 실패" };
  }

  const parsed = safeJSON(raw) || fallbackResult(question);

  const data = {
    score_overall: parsed.score_overall ?? 0,
    scores: parsed.scores ?? {},
    strengths: toStringArray(parsed.strengths),
    gaps: toStringArray(parsed.gaps),
    adds: toStringArray(parsed.adds),
    pitfalls: normalizePitfalls(parsed.pitfalls),
    next: toStringArray(parsed.next),
    logic_flaws: parsed.logic_flaws ?? [],
    missing_details: parsed.missing_details ?? [],
    risk_points: parsed.risk_points ?? [],
    improvements: parsed.improvements ?? [],
    polished: parsed.polished_answers?.advanced ?? "",
    follow_up_questions: parsed.follow_up_questions ?? [],
    keywords: toStringArray(parsed.keywords),
    summary_interviewer: parsed.summary_interviewer ?? "",
    summary_coach: parsed.summary_coach ?? "",
    category: parsed.category ?? pickCategory(question),
    chart: {
      structure: parsed.scores?.structure ?? 0,
      specificity: parsed.scores?.specificity ?? 0,
      logic: parsed.scores?.logic ?? 0,
      tech_depth: parsed.scores?.tech_depth ?? 0,
      risk: parsed.scores?.risk ?? 0,
    },
  };

  const lines = [];
  if (data.summary_interviewer)
    lines.push("면접관 요약: " + data.summary_interviewer);
  if (data.summary_coach)
    lines.push("코치 요약: " + data.summary_coach);

  return { data, feedbackText: lines.join("\n") };
}

module.exports = { gradeAnswer };
