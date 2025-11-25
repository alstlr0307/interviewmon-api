// api/ai.js
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * AI 채점 함수
 * @param {object} param0
 * @returns {Promise<{data: object, feedbackText: string}>}
 */
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  // ============================================================
  //  🔥 JSON 강제 시스템 메시지
  // ============================================================
  const system = `
너는 JSON 생성기다.
절대 JSON 외 다른 출력 금지.

아래 스키마를 엄격히 지켜라:
- 절대 필드 추가 금지
- 절대 필드 삭제 금지
- 순서 변경 허용
- improvements 배열은 반드시 다음만 허용:
  { "before": "", "after": "", "reason": "" }
  (question, desc, msg 등 다른 key 절대 금지)

JSON 문법 오류(괄호, 콤마, 따옴표, 대괄호) 절대 발생시키지 마라.
`;

  // ============================================================
  //  🔥 JSON 스키마 (DB에서 사용하는 key 그대로)
  // ============================================================
  const schema = `
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
  "adds": [],
  "pitfalls": [],
  "next": [],
  "logic_flaws": [],
  "missing_details": [],
  "risk_points": [],
  "improvements": [
    { "before": "", "after": "", "reason": "" }
  ],
  "polished": "",
  "follow_up_questions": [],
  "keywords": [],
  "summary_interviewer": "",
  "summary_coach": "",
  "category": "general",
  "chart": {
    "structure": 0,
    "specificity": 0,
    "logic": 0,
    "tech_depth": 0,
    "risk": 0
  }
}
`;

  // ============================================================
  //  🔥 User 메시지
  // ============================================================
  const user = `
회사: ${company}
직무: ${jobTitle}
면접 질문: ${question}

지원자 답변:
${answer}

위 답변을 다음 JSON 스키마에 맞게 평가해라:

${schema}
`;

  // ============================================================
  //  🔥 OpenAI 호출
  // ============================================================
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  let raw = completion.choices[0]?.message?.content || "{}";

  // ============================================================
  //  🔥 JSON 문자열 정리 (```json ... ``` 같은 경우 방어)
  // ============================================================
  raw = raw.trim();

  // ```json ... ``` 형태 제거
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  }

  // 앞뒤에 이상한 텍스트가 끼어 있어도, 첫 '{' ~ 마지막 '}'만 추출
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  // ============================================================
  //  🔥 JSON 파싱 (실패 방지)
  // ============================================================
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    console.error("RAW OUTPUT:", raw);

    // fallback 구조 (DB 구조와 호환)
    data = {
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
      improvements: [{ before: "", after: "", reason: "" }],
      polished: "",
      follow_up_questions: [],
      keywords: [],
      summary_interviewer: "",
      summary_coach: "",
      category: "general",
      chart: {
        structure: 0,
        specificity: 0,
        logic: 0,
        tech_depth: 0,
        risk: 0,
      },
    };
  }

  // feedbackText = 면접관 요약 + 코치 요약
  const feedbackText = `${data.summary_interviewer || ""}\n${
    data.summary_coach || ""
  }`.trim();

  return {
    data,
    feedbackText,
  };
}

module.exports = { gradeAnswer };
