// ai.js - 업그레이드 버전 (더 풍부한 피드백 + JSON 스키마 고정)
// ------------------------------------------------------------------
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 기본 모델 (환경변수 없으면 gpt-4.1-mini 사용)
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// 한 번에 쓸 수 있는 최대 출력 토큰 (조금 넉넉하게)
const MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 1200);

/**
 * gradeAnswer
 * @param {Object} params
 * @param {string} params.company   - 회사 이름 (예: samsung)
 * @param {string} params.jobTitle  - 직무 이름 (예: backend, soc 등)
 * @param {string} params.question  - 면접 질문
 * @param {string} params.answer    - 지원자 답변
 * @returns {{ data: any, feedbackText: string }}
 */
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const systemPrompt = `
당신은 하드코어 기술 면접관이 아니라,
지원자가 성장할 수 있도록 돕는 "시니어 면접 코치"입니다.

역할:
- 주어진 회사/직무 맥락, 질문, 지원자의 답변을 보고
- 구조화된 JSON 형식으로 면접 피드백을 작성합니다.
- 모든 출력(문장, 키워드, 요약, 불릿)은 한국어로 작성합니다.

점수 규칙:
- scores.* 와 score_overall 은 0~10 사이의 숫자(정수 혹은 소수)입니다.
- 0~3: 매우 부족, 4~5: 부족, 6~7: 보통~양호, 8~9: 우수, 10: 거의 완벽.
- chart.* 역시 0~10 스케일로 주세요.

피드백 스타일:
- 가능하면 STAR 구조(Situation-Task-Action-Result)를 떠올리며 평가합니다.
- 강점/개선/위험요소/다음단계는 "면접에서 바로 참고할 수 있게" 짧고 명확한 문장으로 작성합니다.
- 각 불릿은 1문장 내외, 불필요한 수식어는 줄이고 핵심만 남깁니다.
- 문장 앞에 "강점:" 같은 말은 붙이지 않고, 불릿 자체만 작성합니다.
- 기술 깊이, 협업 방식, 리스크 관리, 의사소통, 구조화된 사고를 잘 잡아냅니다.

요약 규칙:
- summary_interviewer: 면접관 관점의 한 단락 요약 (2~3문장)
- summary_coach: 코치/멘토 관점에서 조언 중심 요약 (2~3문장)
- polished: 기존 답변을 기반으로 한 "이대로 말해도 될 정도"의 개선된 모범 답변 (5~10문장, 한국어)

bullet 개수 가이드(대략적):
- strengths: 3~5개
- gaps: 3~5개
- pitfalls: 2~4개
- next: 3~5개
- follow_up_questions: 3~5개

follow_up_questions:
- 각 항목은 { "question": "...", "reason": "..." } 형태입니다.
- question: 실제 면접에서 바로 물어볼 수 있는 자연스러운 후속 질문
- reason: 그 질문으로 무엇을 검증하려는지 (1문장)
`.trim();

  const userPayload = {
    company,
    jobTitle,
    question,
    answer,
  };

  // JSON Schema 정의 (index.js에서 기대하는 필드와 맞춰둠)
  const jsonSchema = {
    name: "grade_result",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        score_overall: { type: "number" },
        scores: {
          type: "object",
          additionalProperties: false,
          properties: {
            structure: { type: "number" },
            specificity: { type: "number" },
            logic: { type: "number" },
            tech_depth: { type: "number" },
            risk: { type: "number" },
          },
          required: ["structure", "specificity", "logic", "tech_depth", "risk"],
        },
        strengths: {
          type: "array",
          items: { type: "string" },
        },
        gaps: {
          type: "array",
          items: { type: "string" },
        },
        adds: {
          type: "array",
          items: { type: "string" },
        },
        pitfalls: {
          type: "array",
          items: { type: "string" },
        },
        next: {
          type: "array",
          items: { type: "string" },
        },
        logic_flaws: {
          type: "array",
          items: { type: "string" },
        },
        missing_details: {
          type: "array",
          items: { type: "string" },
        },
        risk_points: {
          type: "array",
          items: { type: "string" },
        },
        improvements: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              before: { type: "string" },
              after: { type: "string" },
              reason: { type: "string" },
            },
            required: ["before", "after", "reason"],
          },
        },
        polished: { type: "string" },
        follow_up_questions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              question: { type: "string" },
              reason: { type: "string" },
            },
            required: ["question", "reason"],
          },
        },
        keywords: {
          type: "array",
          items: { type: "string" },
        },
        summary_interviewer: { type: "string" },
        summary_coach: { type: "string" },
        category: { type: "string" },
        chart: {
          type: "object",
          additionalProperties: false,
          properties: {
            structure: { type: "number" },
            specificity: { type: "number" },
            logic: { type: "number" },
            tech_depth: { type: "number" },
            risk: { type: "number" },
          },
        },
      },
      required: [
        "score_overall",
        "scores",
        "strengths",
        "gaps",
        "pitfalls",
        "next",
        "polished",
        "keywords",
        "summary_interviewer",
        "summary_coach",
        "category",
        "chart",
      ],
    },
  };

  const response = await client.responses.create({
    model: MODEL,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
    input: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content:
          "다음은 회사/직무/질문/지원자 답변입니다. 이를 기반으로 JSON 스키마에 맞춰 평가해 주세요.\n\n" +
          JSON.stringify(userPayload, null, 2),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    },
  });

  // json_schema를 사용했기 때문에 content[0].json 으로 바로 객체를 받을 수 있음
  const data =
    response.output &&
    response.output[0] &&
    response.output[0].content &&
    response.output[0].content[0] &&
    response.output[0].content[0].json
      ? response.output[0].content[0].json
      : {};

  // feedbackText: 스토리뱅크에서 짧게 보여줄 때 사용할 1~2줄 요약
  let feedbackParts = [];
  if (data.summary_interviewer) feedbackParts.push(data.summary_interviewer);
  if (data.summary_coach) feedbackParts.push(data.summary_coach);

  const feedbackText = feedbackParts.join("\n");

  return { data, feedbackText };
}

module.exports = {
  gradeAnswer,
};
