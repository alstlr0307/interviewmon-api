// ai.js (gpt-4o-mini + JSON 정규화 + RateLimit 대응 + Fallback 안전버전)

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

function gradeFromScore(score) {
  const s = Number.isFinite(score) ? score : 0;
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
function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function toStringArray(v) {
  return toArray(v)
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x.text === "string") return x.text.trim();
      return "";
    })
    .filter((s) => s.length > 0);
}

function normalizePitfalls(v) {
  return toArray(v)
    .map((p) => {
      if (!p) return null;

      if (typeof p === "string") {
        const t = p.trim();
        return t ? { text: t, level: null } : null;
      }

      const text =
        typeof p.text === "string" && p.text.trim().length > 0
          ? p.text.trim()
          : null;
      if (!text) return null;

      const level =
        typeof p.level === "number" && Number.isFinite(p.level)
          ? p.level
          : null;

      return { text, level };
    })
    .filter(Boolean);
}

function safeJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ JSON 파싱 실패:", raw);
    return null;
  }
}

/* =============================================================
 *  fallback 결과 (AI 오류 시 표시)
 * ============================================================= */
function fallbackResult(question) {
  return {
    score: 0,
    grade: "F",
    summary_interviewer: "",
    summary_coach: "",
    strengths: [],
    gaps: [],
    adds: [],
    pitfalls: [],
    next: [],
    keywords: [],
    category: pickCategory(question),
    polished: "",
  };
}

/* =============================================================
 *  AI 채점 메인 함수
 * ============================================================= */
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const systemPrompt = `
당신은 실리콘밸리 기술면접관 + 시니어 코치입니다.
반드시 JSON 객체 하나만 생성하십시오.
추가 설명 금지.
`;

  const userPrompt = `
【질문】 ${question}
【직무】 ${jobTitle}
【기업】 ${company}

【답변】
${answer}

정확히 아래 스키마로 JSON 생성:
{
  "score": 0,
  "grade": "A",
  "summary_interviewer": "...",
  "summary_coach": "...",
  "strengths": ["..."],
  "gaps": ["..."],
  "adds": ["..."],
  "pitfalls": ["..."],
  "next": ["..."],
  "keywords": ["..."],
  "category": "general",
  "polished": "..."
}
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
    // -------- Rate Limit 대응 --------
    if (e.code === "rate_limit_exceeded") {
      console.error("⚠️ RATE LIMIT 초과:", e.message);

      const fb = fallbackResult(question);
      return {
        data: fb,
        feedbackText: "⚠️ 현재 AI 사용량이 초과되었습니다. 잠시 후 다시 시도해주세요.",
      };
    }

    console.error("❌ AI 호출 오류:", e);

    const fb = fallbackResult(question);
    return {
      data: fb,
      feedbackText: "⚠️ AI 처리 오류가 발생했습니다.",
    };
  }

  const parsed = safeJSON(raw) || fallbackResult(question);

  const score = Number.isFinite(parsed.score) ? Math.round(parsed.score) : 0;

  let grade =
    typeof parsed.grade === "string" && parsed.grade.trim()
      ? parsed.grade.trim().toUpperCase()
      : gradeFromScore(score);

  if (!["S", "A", "B", "C", "D", "F"].includes(grade)) {
    grade = gradeFromScore(score);
  }

  let polished =
    typeof parsed.polished === "string" ? parsed.polished.trim() : "";
  if (polished.length < 10) polished = "";

  const data = {
    score,
    grade,
    summary_interviewer:
      typeof parsed.summary_interviewer === "string"
        ? parsed.summary_interviewer.trim()
        : "",
    summary_coach:
      typeof parsed.summary_coach === "string"
        ? parsed.summary_coach.trim()
        : "",
    strengths: toStringArray(parsed.strengths),
    gaps: toStringArray(parsed.gaps),
    adds: toStringArray(parsed.adds),
    pitfalls: normalizePitfalls(parsed.pitfalls),
    next: toStringArray(parsed.next),
    keywords: toStringArray(parsed.keywords),
    category:
      typeof parsed.category === "string" && parsed.category.trim()
        ? parsed.category.trim()
        : pickCategory(question),
    polished,
  };

  /* ------------ 피드백 텍스트 조립 ------------- */
  const lines = [];

  if (data.summary_interviewer)
    lines.push(`면접관 요약: ${data.summary_interviewer}`);
  if (data.summary_coach)
    lines.push(`코치 요약: ${data.summary_coach}`);

  lines.push("\n■ Strengths");
  data.strengths.length
    ? data.strengths.forEach((s) => lines.push("• " + s))
    : lines.push("• (내용 없음)");

  lines.push("\n■ Gaps");
  data.gaps.length
    ? data.gaps.forEach((s) => lines.push("• " + s))
    : lines.push("• (내용 없음)");

  lines.push("\n■ Adds");
  data.adds.length
    ? data.adds.forEach((s) => lines.push("• " + s))
    : lines.push("• (내용 없음)");

  lines.push("\n■ Pitfalls");
  data.pitfalls.length
    ? data.pitfalls.forEach((p) =>
        lines.push(
          p.level != null ? `• (레벨 ${p.level}) ${p.text}` : `• ${p.text}`
        )
      )
    : lines.push("• (내용 없음)");

  lines.push("\n■ Next");
  data.next.length
    ? data.next.forEach((s) => lines.push("• " + s))
    : lines.push("• (내용 없음)");

  if (data.polished) {
    lines.push("\n■ Polished");
    lines.push(data.polished);
  }

  return {
    data,
    feedbackText: lines.join("\n"),
  };
}

module.exports = { gradeAnswer };
