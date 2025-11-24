// ai.js (InterviewMon AI V5 – Production Grade)
// GPT 기반 심층 평가: STAR, 정량성, 논리성, 직무 기술성, 위험요소, 10축 차트, Follow-up 질문, 모범답변 생성

const OpenAI = require("openai");
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ----------------------------------------------------------
// 카테고리 식별기
// ----------------------------------------------------------
function pickCategory(question = "") {
  const q = question.toLowerCase();
  if (/(lead|mentor|conflict|communication)/.test(q)) return "behavior";
  if (/(perf|latency|qps|cpu|gpu|cache|optimi)/.test(q)) return "tech";
  if (/(archi|design|scale|traffic|db|service)/.test(q)) return "architecture";
  if (/(incident|failure|postmortem)/.test(q)) return "incident";
  if (/(data|metric|ab|experiment)/.test(q)) return "data";
  return "general";
}

// ----------------------------------------------------------
// GPT 평가 엔진
// ----------------------------------------------------------
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  // 🟣 강력한 System Prompt (AI 행동 고정)
  const systemPrompt = `
당신은 실리콘밸리 기술면접관 + 시니어 코치입니다.
절대 장황하게 설명하지 말고, JSON만 정확하게 생성해야 합니다.

규칙:
1) JSON 외 문장은 절대 출력하지 않음.
2) null 대신 빈 배열([]) 또는 0을 사용.
3) 점수는 반드시 정수(0~100).
4) diff는 '-' 삭제 + '+' 추가 형식 유지.
5) polished는 10~18줄 사이로 제한.
6) follow_up_questions는 최소 3개, 최대 6개.
7) chart 축은 모두 0~100 사이 정수.
8) 누락된 필드 있으면 안 됨.
`;

  // 🟦 User Prompt
  const userPrompt = `
아래 답변을 분석하세요.

【질문】 ${question}
【직무】 ${jobTitle}
【기업】 ${company}

【지원자 답변】
${answer}

출력 형식(JSON only):

{
  "score": 0~100 정수,
  "grade": "S" | "A" | "B" | "C" | "D" | "F",

  "summary_interviewer": "...",
  "summary_coach": "...",

  "strengths": ["항목"],
  "gaps": ["항목"],
  "adds": ["항목"],
  "pitfalls": [
    { "text": "문장", "level": 1~3 }
  ],
  "next": ["항목"],

  "rewrite_diff": "diff 형식",

  "follow_up_questions": ["질문1", "질문2", ...],

  "chart": {
    "star_s": 0~100,
    "star_t": 0~100,
    "star_a": 0~100,
    "star_r": 0~100,
    "quant": 0~100,
    "logic": 0~100,
    "tech": 0~100,
    "fit": 0~100,
    "brevity": 0~100,
    "risk": 0~100
  },

  "keywords": ["키워드"],
  "category": "tech | behavior | data | architecture | incident | general",

  "polished": "모범답변 (10~18줄)"
}
`;

  // ----------------------------------------------------------
  // GPT 요청
  // ----------------------------------------------------------
  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const data = response.choices[0].message.parsed;

  // ----------------------------------------------------------
  // 후처리 안정성 보정
  // ----------------------------------------------------------

  // 카테고리 누락 시 자동 보정
  data.category = data.category || pickCategory(question);

  // 점수/차트값 정수화 + 범위 제한
  if (data.chart) {
    for (const k of Object.keys(data.chart)) {
      let v = Number(data.chart[k]);
      if (!Number.isFinite(v)) v = 0;
      data.chart[k] = Math.min(100, Math.max(0, Math.round(v)));
    }
  }

  // 점수 보정
  if (!Number.isFinite(data.score)) data.score = 0;
  data.score = Math.max(0, Math.min(100, Math.round(data.score)));

  // pitfall level 보정
  if (Array.isArray(data.pitfalls)) {
    data.pitfalls = data.pitfalls.map((p) => ({
      text: p.text || "",
      level: Math.max(1, Math.min(3, Number(p.level) || 1)),
    }));
  }

  // polished(모범답변) 길이 보정
  if (data.polished) {
    const lines = data.polished.trim().split("\n");
    if (lines.length < 8) data.polished = expandPolished(data.polished);
    if (lines.length > 20) data.polished = lines.slice(0, 18).join("\n");
  }

  return {
    data,
    feedbackText: buildFeedbackText(data),
  };
}

// ----------------------------------------------------------
// polished 자동 확장 보정
// ----------------------------------------------------------
function expandPolished(text) {
  // 답변이 너무 짧을 경우 안전하게 STAR 형태로 확장
  return `
[S] 상황: 문제의 원인이 되었던 초기 조건을 명확히 설명합니다.
[T] 과제: 해결해야 했던 목표 또는 요구사항을 제시합니다.
[A] 행동: 적용한 전략·기술·협업 방식 등을 구체적으로 단계별로 보여줍니다.
[R] 결과: 수치/퍼센트 기반의 개선 성과를 구조화하여 설명합니다.

${text}
`.trim();
}

// ----------------------------------------------------------
// 기존 텍스트형 피드백 생성기
// ----------------------------------------------------------
function buildFeedbackText(ai) {
  return [
    `면접관 요약: ${ai.summary_interviewer}`,
    "",
    `코치 요약: ${ai.summary_coach}`,
    "",
    "■ Strengths",
    ...(ai.strengths || []).map((s) => `• ${s}`),
    "",
    "■ Gaps",
    ...(ai.gaps || []).map((s) => `• ${s}`),
    "",
    "■ Adds",
    ...(ai.adds || []).map((s) => `• ${s}`),
    "",
    "■ Pitfalls",
    ...(ai.pitfalls || []).map((p) => `• (레벨 ${p.level}) ${p.text}`),
    "",
    "■ Next Steps",
    ...(ai.next || []).map((s) => `• ${s}`),
    "",
    "■ Polished",
    ai.polished || "",
  ].join("\n");
}

module.exports = { gradeAnswer };
