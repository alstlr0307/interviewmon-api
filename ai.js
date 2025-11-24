// ai.js (JSON 정규화 + Pitfalls/Polished 안전 처리 버전)

const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

/* ---------- 유틸: 배열/문자열 정규화 ---------- */
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
  // 언제 와도 { text, level? }[] 로 맞춘다
  return toArray(v)
    .map((p) => {
      if (!p) return null;

      if (typeof p === "string") {
        const t = p.trim();
        if (!t) return null;
        return { text: t, level: null };
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

async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  const systemPrompt = `
당신은 실리콘밸리 기술면접관 + 시니어 코치입니다.
반드시 JSON 한 개의 객체만 생성하십시오. 추가 설명/텍스트는 쓰지 마십시오.
  `;

  const userPrompt = `
【질문】 ${question}
【직무】 ${jobTitle}
【기업】 ${company}

【답변】
${answer}

다음 JSON 스키마를 정확히 따르십시오.

{
  "score": 0,                            // 0~100 정수
  "grade": "A",                          // "S","A","B","C","D","F" 중 하나
  "summary_interviewer": "...",          // 면접관 요약 (2~3문장)
  "summary_coach": "...",                // 코치 관점 요약 (2~3문장)
  "strengths": ["..."],                  // 강점 리스트 (문장 단위)
  "gaps": ["..."],                       // 부족한 점 리스트
  "adds": ["..."],                       // 추가하면 좋은 내용
  "pitfalls": ["..."],                   // 주의할 함정 (문장 리스트)
  "next": ["..."],                       // 다음 도전/학습 방향
  "keywords": ["..."],                   // 키워드 리스트
  "category": "general",                 // behavior / tech / architecture / incident / data / general
  "polished": "..."                      // 실제 면접에서 그대로 말해도 될 정제된 한 단락 (없으면 빈 문자열)
}
`;

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  let raw = response.choices[0].message.content;
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("AI JSON parse error:", raw, e);
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    // 완전 망한 경우 기본값 리턴
    const fallback = {
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
    return {
      data: fallback,
      feedbackText: buildFeedbackText(fallback),
    };
  }

  // 🔧 JSON 결과 정규화
  const score = Number.isFinite(parsed.score) ? Math.round(parsed.score) : 0;
  let grade =
    typeof parsed.grade === "string" && parsed.grade.trim()
      ? parsed.grade.trim().toUpperCase()
      : null;
  if (!["S", "A", "B", "C", "D", "F"].includes(grade)) {
    grade = gradeFromScore(score);
  }

  let polished =
    typeof parsed.polished === "string" ? parsed.polished.trim() : "";
  // "yes" 같은 쓰레기 값은 버리기 (길이 너무 짧으면 폐기)
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

  const feedbackText = buildFeedbackText(data);

  return {
    data,
    feedbackText,
  };
}

function buildFeedbackText(ai) {
  const lines = [];

  if (ai.summary_interviewer) {
    lines.push(`면접관 요약: ${ai.summary_interviewer}`);
  }
  if (ai.summary_coach) {
    lines.push(`코치 요약: ${ai.summary_coach}`);
  }

  // Strengths
  lines.push("");
  lines.push("■ Strengths");
  if (ai.strengths && ai.strengths.length) {
    ai.strengths.forEach((s) => lines.push(`• ${s}`));
  } else {
    lines.push("• (내용 없음)");
  }

  // Gaps
  lines.push("");
  lines.push("■ Gaps");
  if (ai.gaps && ai.gaps.length) {
    ai.gaps.forEach((s) => lines.push(`• ${s}`));
  } else {
    lines.push("• (내용 없음)");
  }

  // Adds
  lines.push("");
  lines.push("■ Adds");
  if (ai.adds && ai.adds.length) {
    ai.adds.forEach((s) => lines.push(`• ${s}`));
  } else {
    lines.push("• (내용 없음)");
  }

  // Pitfalls
  lines.push("");
  lines.push("■ Pitfalls");
  const pitfalls = normalizePitfalls(ai.pitfalls);
  if (pitfalls.length) {
    pitfalls.forEach((p) => {
      if (p.level != null) {
        lines.push(`• (레벨 ${p.level}) ${p.text}`);
      } else {
        lines.push(`• ${p.text}`);
      }
    });
  } else {
    lines.push("• (내용 없음)");
  }

  // Next steps
  lines.push("");
  lines.push("■ Next Steps");
  if (ai.next && ai.next.length) {
    ai.next.forEach((s) => lines.push(`• ${s}`));
  } else {
    lines.push("• (내용 없음)");
  }

  // Polished
  if (ai.polished && ai.polished.trim().length > 0) {
    lines.push("");
    lines.push("■ Polished");
    lines.push(ai.polished.trim());
  }

  return lines.join("\n");
}

module.exports = { gradeAnswer };
