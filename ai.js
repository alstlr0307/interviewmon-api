// api/ai.js
// -----------------------------------------------------------------------------
// 면접 답변 AI 평가 모듈
// - OpenAI에 질문/답변을 보내서 JSON 형태의 평가 결과를 받는다.
// - score_overall / scores.* 는 0~10 점수로 반환 (index.js에서 0~100으로 변환 + 보정)
// - feedbackText 는 summary/strengths/gaps/next 등을 한글 문단으로 묶은 문자열
// -----------------------------------------------------------------------------

const OpenAI = require("openai");

// 사용할 모델 (환경변수로 오버라이드 가능)
const MODEL = process.env.OPENAI_GRADE_MODEL || "gpt-4o-mini";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------------------------------------------------
// 1) 프롬프트 생성
// -----------------------------------------------------------------------------
function buildPrompt({ company, jobTitle, question, answer }) {
  const companyPart = company ? `지원 회사: ${company}` : "지원 회사: (미지정)";
  const jobPart = jobTitle ? `지원 직무: ${jobTitle}` : "지원 직무: (미지정)";

  return `
너는 기술 면접관이자 코치 역할을 하는 AI이다.
지원자의 한국어 면접 답변을 평가하고, JSON 형식으로만 결과를 반환해야 한다.

[맥락]
- ${companyPart}
- ${jobPart}

[질문]
${question || "(질문 없음)"}

[지원자의 답변]
${answer || "(답변 없음)"}

[평가 기준]
- structure: 답변 구조, 논리 흐름 (STAR 구조 등)
- specificity: 구체성, 수치/사례의 활용 정도
- logic: 논리적 설득력, 인과 관계의 명확성
- tech_depth: 기술적 깊이, 핵심 개념 이해도
- risk: 리스크 인식과 대응, 한계에 대한 인지

[점수 규칙]
- score_overall 과 scores.* 는 모두 0~10 사이의 정수 또는 소수.
- 0점은 최악, 10점은 완벽에 가까운 수준.
- 한국 실무 개발자 기준으로 너무 깐깐하지 않게, 평균적인 괜찮은 답변이면 6~8점 정도를 주어라.
- 점수는 "절대 평가"가 아니라 "현실적인 취업 준비생" 기준으로 채점한다.

[JSON 스키마]
반드시 아래와 같은 JSON 객체 한 개만, 추가 텍스트 없이 반환한다.

{
  "score_overall": number,             // 0~10
  "scores": {
    "structure": number,               // 0~10
    "specificity": number,             // 0~10
    "logic": number,                   // 0~10
    "tech_depth": number,              // 0~10
    "risk": number                     // 0~10
  },
  "strengths": string[],               // 좋은 점 한글 문장 배열
  "gaps": string[],                    // 개선해야 할 점 한글 문장 배열
  "adds": string[],                    // 있으면 좋은 추가 내용
  "pitfalls": string[],                // 주의해야 할 실수/위험
  "next": string[],                    // 다음 연습/개선 액션
  "logic_flaws": string[],             // 논리적인 약점
  "missing_details": string[],         // 빠진 디테일
  "risk_points": string[],             // 리스크 관련 포인트
  "improvements": [                    // 선택적 문장 리라이팅/개선 제안
    {
      "before": string,
      "after": string,
      "reason": string
    }
  ],
  "polished": string,                  // 전체 답변을 더 다듬은 버전 (없으면 빈 문자열)
  "follow_up_questions": [             // 추가로 물어볼 만한 질문
    {
      "question": string,
      "reason": string
    }
  ],
  "keywords": string[],                // 핵심 키워드
  "summary_interviewer": string,       // 면접관 관점 요약
  "summary_coach": string,             // 코치 관점 요약
  "category": string,                  // ex) "culture", "leadership" 등
  "chart": {                           // 레이더 차트용 0~10 점수 (scores와 동일키 사용, 없으면 비워도 됨)
    "structure": number,
    "specificity": number,
    "logic": number,
    "tech_depth": number,
    "risk": number
  }
}

- 반드시 유효한 JSON 문자열만 반환하고, 주석이나 설명 문장은 절대 넣지 말 것.
`;
}

// -----------------------------------------------------------------------------
// 2) gradeAnswer: OpenAI 호출 + JSON 파싱 + feedbackText 생성
// -----------------------------------------------------------------------------
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const prompt = buildPrompt({ company, jobTitle, question, answer });

  // 2-1. OpenAI 호출 (JSON 모드)
  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "너는 한국어 기술 면접 답변을 평가하는 AI 코치다. 반드시 유효한 JSON 객체 하나만 반환해야 한다.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || "{}";

  // 2-2. JSON 파싱 (망가져도 안전하게)
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    console.error("[gradeAnswer] JSON parse error:", e.message);
    console.error("raw content:", content);
    // 최소 구조라도 채워서 리턴
    data = {
      score_overall: 5,
      scores: {
        structure: 5,
        specificity: 5,
        logic: 5,
        tech_depth: 5,
        risk: 5,
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
      polished: "",
      follow_up_questions: [],
      keywords: [],
      summary_interviewer: "",
      summary_coach: "",
      category: "general",
      chart: {},
    };
  }

  // 2-3. feedbackText 생성 (요약 문단)
  const lines = [];

  if (data.summary_interviewer && String(data.summary_interviewer).trim()) {
    lines.push(String(data.summary_interviewer).trim());
  }
  if (data.summary_coach && String(data.summary_coach).trim()) {
    lines.push(String(data.summary_coach).trim());
  }

  if (Array.isArray(data.strengths) && data.strengths.length > 0) {
    lines.push(`강점: ${data.strengths.join(", ")}`);
  }
  if (Array.isArray(data.gaps) && data.gaps.length > 0) {
    lines.push(`보완점: ${data.gaps.join(", ")}`);
  }
  if (Array.isArray(data.next) && data.next.length > 0) {
    lines.push(`다음 액션: ${data.next.join(", ")}`);
  }

  if (lines.length === 0) {
    lines.push(
      "이번 답변에 대한 상세 요약 정보를 생성하지 못했습니다. 강점과 보완점을 스스로 정리해 보며 한 번 더 다듬어 보세요."
    );
  }

  const feedbackText = lines.join("\n");

  return { data, feedbackText };
}

// -----------------------------------------------------------------------------
// 3) exports
// -----------------------------------------------------------------------------
module.exports = {
  gradeAnswer,
};
