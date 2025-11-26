// ai.js
// -----------------------------------------------------------------------------
// Chat Completions 기반 AI 피드백 모듈 (JSON 전용 + 인터뷰 코치 스타일)
//  - model: 환경변수 OPENAI_MODEL 없으면 gpt-4.1-mini 사용
//  - 응답 형식: response_format: { type: "json_object" }  (Responses API 아님)
//  - 점수: 세부 항목은 0~10점, 최종 총점은 0~100점으로 계산할 수 있게 설계
// -----------------------------------------------------------------------------

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Chat Completions에서 쓸 모델
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// 안전한 숫자 변환
function toNumber(v, fallback = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 0~10 범위로 클램프
function clampScore10(v, fallback = 7) {
  const n = toNumber(v, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, Math.round(n)));
}

// 문자열 배열로 정제
function toStringArray(arr, limit = 10) {
  if (!Array.isArray(arr)) return [];
  const res = [];
  for (const v of arr) {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) res.push(s);
    }
    if (res.length >= limit) break;
  }
  return res;
}

// 팔로업 질문 배열 정제 (객체 or 문자열 → 통일)
function normalizeFollowUps(arr, limit = 5) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      out.push({ question: s, reason: "" });
    } else if (v && typeof v === "object") {
      const q = (v.question || "").toString().trim();
      const r = (v.reason || "").toString().trim();
      if (!q) continue;
      out.push({ question: q, reason: r });
    }
    if (out.length >= limit) break;
  }
  return out;
}

// 점수 요약 문장 텍스트 생성
function buildFeedbackText(data, totalScore, scores) {
  const summaryInterviewer =
    (data && data.summary_interviewer) ||
    "지원자는 전반적으로 강점과 개선 포인트를 균형 있게 보여주었습니다.";
  const summaryCoach =
    (data && data.summary_coach) ||
    "세부 기술적 깊이와 구체적인 수치/사례를 보완하면 더 강력한 답변이 될 것입니다.";

  const parts = [];
  parts.push(`총점은 ${totalScore}점(100점 만점)입니다.`);

  if (scores) {
    const s = scores;
    parts.push(
      `구조 ${s.structure}점, 구체성 ${s.specificity}점, 논리 ${s.logic}점, 기술 깊이 ${s.tech_depth}점, 리스크 관리 ${s.risk}점으로 평가되었습니다.`
    );
  }

  parts.push(summaryInterviewer);
  parts.push(summaryCoach);

  return parts.join("\n");
}

// 시스템 프롬프트
function buildSystemPrompt() {
  return `
당신은 한국어로 답변하는 시니어 기술 인터뷰 코치입니다.

목표:
- 지원자의 답변을 바탕으로, 실무에서 바로 활용 가능한 수준의 인터뷰 피드백을 제공합니다.
- "개발자 실무 경험"을 중심으로 평가하며, 말만 화려한 답변보다는 실제 행동과 결과에 집중합니다.
- 반드시 JSON 형식의 결과만 반환해야 하며, 코드 블록(\`\`\`)은 절대 사용하지 않습니다.

평가 기준 (세부 점수는 모두 0~10점 정수):
- structure: 답변의 구조, 흐름, STAR(Situation-Task-Action-Result) 관점에서의 완성도
- specificity: 예시, 숫자, 지표, 도구 이름 등 구체적인 내용의 정도
- logic: 문제 인식 → 접근 → 실행 → 결과의 논리적 연결성
- tech_depth: 기술적 깊이, 아키텍처/도구 선택 이유, 성능/품질에 대한 이해
- risk: 리스크 인식 및 대응, 품질/안정성/보안에 대한 고려

총점:
- 위 5개 세부 점수(0~10)의 평균을 기반으로 0~100점 스코어를 계산합니다.
- 이 총점은 "score_overall" 필드에 0~100 범위로 넣어 주세요.

JSON 필드 설명:
- score_overall: number (0~100) – 전체 종합 점수
- scores: object
  - structure, specificity, logic, tech_depth, risk: 각 0~10 정수
- strengths: string[] – 면접관 입장에서 "이 지원자의 강점"이라 느껴지는 포인트들
- gaps: string[] – 아쉽거나 부족한 부분 (기술/구조/스토리 등)
- adds: string[] – 답변에 추가하면 좋을 내용 (예: 수치, 예시, 도구 선택 이유 등)
- pitfalls: string[] – 면접에서 조심해야 할 위험 요소 (오해 소지, 과장, 모호함 등)
- next: string[] – 다음 인터뷰까지 준비하면 좋은 실질적인 액션 아이템
- logic_flaws: string[] – 논리적 비약, 앞뒤가 어색한 부분
- missing_details: string[] – 반드시 있었으면 좋았을 구체적인 디테일
- risk_points: string[] – 리스크 관리 측면에서 부족한 부분
- improvements: { before: string; after: string; reason: string; }[]
  - 실제 답변의 문장을 "이전(before) → 개선(after)" 형태로 1~3개 제시
- polished: string
  - 실제 면접에서 그대로 읽어도 되는 수준의 "다듬어진 모범 답변" (1~3단락 정도)
- follow_up_questions: { question: string; reason: string; }[]
  - 면접관이 실제로 던질 수 있는 추가 질문과, 그 질문을 던지는 이유
- keywords: string[] – 이 답변을 요약하는 핵심 키워드 (회사/기술/행동 키워드 중심)
- summary_interviewer: string – 면접관이 평가서에 적을 법한 한 단락 요약
- summary_coach: string – 코치 입장에서 지원자에게 해주는 조언 한 단락
- category: string – "culture", "collaboration", "ownership", "problem_solving", "tech_depth" 등 중 가장 어울리는 카테고리
- chart: object – { structure, specificity, logic, tech_depth, risk } 점수(0~10) 그대로 넣기

반드시 지켜야 할 형식 규칙:
- 최종 출력은 유효한 JSON 한 덩어리여야 합니다.
- JSON 앞뒤에 설명 문장, 주석, 마크다운, \`\`\`json 코드블록 등은 절대 넣지 마세요.
- 값이 비어도 필드는 모두 포함해 주세요(예: 빈 배열은 [] 로).
`;
}

// 사용자 프롬프트
function buildUserPrompt({ company, jobTitle, question, answer }) {
  const c = company || "알 수 없음";
  const j = jobTitle || "알 수 없음";

  const example = {
    score_overall: 82,
    scores: {
      structure: 8,
      specificity: 8,
      logic: 8,
      tech_depth: 8,
      risk: 8,
    },
    strengths: ["구체적인 수치와 사례 제시", "협업 과정에서의 역할이 명확함"],
    gaps: ["기술 선택 이유에 대한 설명 부족"],
    adds: ["성능 개선 폭을 숫자로 제시"],
    pitfalls: ["용어를 너무 빠르게 설명 없이 사용하지 않기"],
    next: ["비슷한 사례를 1~2개 더 정리해두기"],
    logic_flaws: [],
    missing_details: ["도입 전/후 비교 수치"],
    risk_points: ["테스트 전략에 대한 언급 부족"],
    improvements: [
      {
        before: "문제 상황을 간단히 설명했습니다.",
        after:
          "처음에는 CPU 사용률이 90%를 넘기면서도 응답 시간이 1초 이상 지연되는 문제가 있었습니다.",
        reason: "상황과 문제의 심각도가 더 잘 드러나도록 구체화.",
      },
    ],
    polished:
      "다듬어진 모범 답변 예시가 여기에 들어갑니다. 실제 면접에서 그대로 읽어도 자연스러운 수준으로 작성해 주세요.",
    follow_up_questions: [
      {
        question: "이 과정에서 가장 어려웠던 의사결정은 무엇이었나요?",
        reason: "지원자의 의사결정 기준과 우선순위를 파악하기 위해.",
      },
    ],
    keywords: ["리팩터링", "품질 개선", "협업", "테스트 자동화"],
    summary_interviewer:
      "지원자는 리팩터링과 테스트 자동화를 통해 품질을 개선한 경험을 잘 설명했습니다.",
    summary_coach:
      "구조와 논리는 좋지만, 성과를 숫자로 더 보완하면 훨씬 강력한 답변이 될 것입니다.",
    category: "tech_depth",
    chart: {
      structure: 8,
      specificity: 8,
      logic: 8,
      tech_depth: 8,
      risk: 8,
    },
  };

  return `
회사: ${c}
직무/포지션: ${j}

면접 질문:
${question || "(질문 없음)"}

지원자 답변:
${answer || "(답변 없음)"}

위 내용을 바탕으로, 앞에서 설명한 JSON 스키마에 맞는 평가 결과를 생성해 주세요.
반드시 아래 예시와 유사한 구조의 "JSON만" 반환해야 합니다. (설명 문장/코드블록 금지)

예시(JSON 구조 참고용, 실제 값은 새로 계산해서 채워 넣으세요):
${JSON.stringify(example, null, 2)}
`;
}

// 실제로 호출되는 함수: index.js에서 사용하는 인터페이스 유지
async function gradeAnswer({ company, jobTitle, question, answer }) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ company, jobTitle, question, answer });

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.35, // 살짝 창의적이지만 일관성 유지
    max_tokens: 1200,  // 토큰 조금 넉넉하게
    response_format: { type: "json_object" }, // ✅ Chat Completions용 JSON 강제
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  let content = completion.choices?.[0]?.message?.content || "{}";
  content = content.trim();

  let raw;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    console.error("[gradeAnswer] JSON parse 실패, 원본 content =", content);
    // 완전 깨지더라도 기본 구조는 채워서 리턴
    raw = {};
  }

  // 점수 정제
  const scoresRaw = raw.scores || {};
  const normScores = {
    structure: clampScore10(scoresRaw.structure, 7),
    specificity: clampScore10(scoresRaw.specificity, 7),
    logic: clampScore10(scoresRaw.logic, 7),
    tech_depth: clampScore10(scoresRaw.tech_depth, 7),
    risk: clampScore10(scoresRaw.risk, 7),
  };

  // 총점(0~100) 계산 – index.js에서 다시 계산하긴 하지만 여기서도 넣어둠
  const avg10 =
    (normScores.structure +
      normScores.specificity +
      normScores.logic +
      normScores.tech_depth +
      normScores.risk) /
    5;
  const totalScore = Math.max(0, Math.min(100, Math.round(avg10 * 10)));

  const data = {
    score_overall: toNumber(raw.score_overall, totalScore),
    scores: normScores,
    strengths: toStringArray(raw.strengths, 10),
    gaps: toStringArray(raw.gaps, 10),
    adds: toStringArray(raw.adds, 10),
    pitfalls: toStringArray(raw.pitfalls, 10),
    next: toStringArray(raw.next, 10),
    logic_flaws: toStringArray(raw.logic_flaws, 10),
    missing_details: toStringArray(raw.missing_details, 10),
    risk_points: toStringArray(raw.risk_points, 10),
    improvements: Array.isArray(raw.improvements)
      ? raw.improvements
          .filter(
            (im) =>
              im &&
              typeof im === "object" &&
              typeof im.before === "string" &&
              typeof im.after === "string"
          )
          .slice(0, 5)
      : [],
    polished: (raw.polished || "").toString(),
    follow_up_questions: normalizeFollowUps(raw.follow_up_questions, 5),
    keywords: toStringArray(raw.keywords, 10),
    summary_interviewer: (raw.summary_interviewer || "").toString(),
    summary_coach: (raw.summary_coach || "").toString(),
    category: (raw.category || "general").toString(),
    chart: {
      structure: normScores.structure,
      specificity: normScores.specificity,
      logic: normScores.logic,
      tech_depth: normScores.tech_depth,
      risk: normScores.risk,
    },
  };

  const feedbackText = buildFeedbackText(data, totalScore, normScores);

  return { data, feedbackText };
}

module.exports = { gradeAnswer };
