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
  //  🔥 SYSTEM 프롬프트 (JSON 전용 + 평가 기준 강화)
  // ============================================================
  const system = `
너는 한국어 기술/행동 면접 답변을 평가하는 AI 코치지만,
출력은 "오직 하나의 JSON" 객체만 반환하는 JSON 생성기다.

반드시 지켜야 할 규칙:

1) 출력 형식
- JSON 이외의 텍스트(설명, 문장, 마크다운, 코멘트) 절대 금지
- 공백/개행은 허용하지만 데이터는 반드시 유효한 JSON이어야 한다.
- JSON 문법 오류(괄호, 콤마, 따옴표, 대괄호) 절대 발생 금지

2) 스키마 규칙
- 아래 스키마의 필드만 사용한다.
- 필드 "추가" 금지, "삭제" 금지
- 필드 순서는 바뀌어도 상관없다.
- improvements 배열의 각 원소는 반드시
  { "before": "", "after": "", "reason": "" } 형태여야 한다.
  (question, desc, msg 등 다른 key 사용 금지)

3) 평가 기준 (0~100점)
- score_overall:
  - 답변의 전반적인 완성도 (구조 + 구체성 + 논리 + 기술 깊이 + 리스크 인식)
- scores.structure:
  - STAR 구조(상황/과제/행동/결과)가 얼마나 명확한지
- scores.specificity:
  - 수치, 지표, 구체 예시가 얼마나 들어 있는지
- scores.logic:
  - 원인-결과, 선택-근거 등이 논리적으로 연결되어 있는지
- scores.tech_depth:
  - 기술/도메인 깊이(표면적인 설명 vs 실제로 해본 사람 느낌)
- scores.risk:
  - 리스크, 장애, 한계, 트레이드오프에 대한 인식과 대응이 있는지

4) 각 필드 설명
- strengths: 답변에서 잘한 점 3~6개, 한 줄 요약으로
- gaps: 반드시 보완해야 할 부분 3~6개
- adds: 있으면 좋은 추가 포인트 2~5개
- pitfalls: 오해/위험 요소 (text + 위험도 level 1~3)
- next: 다음 답변에서 바로 쓸 수 있는 행동 가이드 문장들
- logic_flaws, missing_details, risk_points:
  - 구조/논리/리스크 관점에서의 구체적인 문제 요약
- improvements:
  - before: 현재 답변의 일부 문장 또는 표현
  - after: 면접에서 그대로 말해도 좋은 개선 문장
  - reason: 왜 그렇게 고쳤는지 (면접/커뮤니케이션 관점)
- polished:
  - 실제 면접에서 사용할 수 있는 모범 답변 (지원자의 톤을 유지하며 정리)
- follow_up_questions:
  - 면접관이 실제로 이어서 물어볼 법한 후속 질문
  - { "question": "", "reason": "" } 형태 사용

절대 잊지 마라:
- JSON 이외의 텍스트를 출력하면 안 된다.
- JSON 스키마를 벗어나면 안 된다.
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
  //  🔥 User 메시지 (컨텍스트 + 스키마)
  // ============================================================
  const user = `
회사: ${company || "미지정"}
직무: ${jobTitle || "미지정"}
면접 질문: ${question}

지원자 답변:
${answer}

요구 사항:
1) 위 답변을 실제 기술/행동 면접이라고 가정하고 냉정하게 평가한다.
2) 점수는 0~100 사이 정수로만 채운다.
3) strengths/gaps/adds/next는 실제 면접 피드백처럼 자연어 한국어 한 줄 요약으로 쓴다.
4) polished는 "실제 면접 자리에서 그대로 말해도 되는 수준"으로 다듬는다.
5) follow_up_questions에는 면접관이 실제로 이어서 물을 수 있는 질문을 넣는다.

반드시 아래 JSON 스키마를 그대로 사용해 채워 넣어라:

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
  //  🔥 JSON 파싱 (실패 시 fallback)
  // ============================================================
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    console.error("RAW OUTPUT:", raw);

    // 최소 fallback 구조
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
