// ai.js
// -----------------------------------------------------------------------------
// 규칙 기반 경량 평가기: STAR/지표/기술 키워드/톤을 종합해 점수·등급·섹션(강점/보완/추가/주의/다음)을 생성
// DB에는 완본 텍스트(feedbackText)를 저장하고, API 응답엔 구조화 필드를 함께 내려줍니다.
// -----------------------------------------------------------------------------

function pickCategory(question = "") {
  const q = question.toLowerCase();
  if (/(lead|ownership|mentor|conflict|communication|culture)/.test(q)) return "behavior";
  if (/(perf|latency|qps|cpu|gpu|optimi|cache|branch|icache|lto|pgo)/.test(q)) return "tech";
  if (/(archi|design|scale|traffic|db|cache|mq|micro|service)/.test(q)) return "architecture";
  if (/(incident|failure|postmortem|outage|sev)/.test(q)) return "incident";
  if (/(data|metric|kpi|ab|exp|cohort|funnel)/.test(q)) return "data";
  return "general";
}

function scoreAnswer(question, answer) {
  const a = (answer || "").trim();
  if (!a) return 0;

  let score = 20;

  // 길이 가산
  const len = a.length;
  if (len >= 80) score += 10;
  if (len >= 160) score += 10;
  if (len >= 300) score += 10;
  if (len >= 450) score += 10;

  // STAR 감지
  const hasS = /상황|situation/i.test(a);
  const hasT = /과제|task|목표/i.test(a);
  const hasA = /행동|action|조치/i.test(a);
  const hasR = /결과|result|성과|지표/i.test(a);
  const starCount = [hasS, hasT, hasA, hasR].filter(Boolean).length;
  score += starCount * 8;

  // 숫자/지표
  if (/\b(\d+(\.\d+)?)(\s?%|ms|s|qps|배|건|회)\b/i.test(a)) score += 10;
  if (/\b(전후|before|after|baseline|target)\b/i.test(a)) score += 5;

  // 기술 키워드
  const techKW = /(프로파일|profil|플레임|flame|벤치|bench|캐시|cache|배치|batch|큐|queue|샤딩|shard|리트라이|retry|circuit|idempot)/i;
  if (techKW.test(a)) score += 10;

  // 회고/재발 방지
  if (/(회고|postmortem|재발|prevent|rca|원인분석)/i.test(a)) score += 8;

  // 위험한 표현 패널티
  if (/(아마|대충|그냥)/i.test(a)) score -= 5;
  if (/(완벽|절대)/i.test(a)) score -= 3;

  // 범위 제한
  score = Math.max(0, Math.min(100, score));
  return score;
}

function gradeFromScore(s) {
  if (s >= 90) return "S";
  if (s >= 80) return "A";
  if (s >= 70) return "B";
  if (s >= 60) return "C";
  if (s >= 50) return "D";
  return "F";
}

function extractKeywords(question, answer) {
  const text = `${question} ${answer}`.toLowerCase();
  const dict = ["latency", "cache", "batch", "retry", "circuit", "idempotent", "ab", "metric", "scale", "profiling", "shard", "timeout", "throughput"];
  const hit = dict.filter(k => text.includes(k));
  const miss = dict.filter(k => !text.includes(k)).slice(0, 6);
  return { hit, miss };
}

function craftPolished(answer) {
  // STAR 미사용 시 간단 STAR 템플릿
  if (!/(상황|과제|행동|결과)/.test(answer)) {
    return [
      "상황: 운영 환경에서 초기 로드 지연이 관찰되었습니다.",
      "과제: 초기 로드 시간을 30% 이상 단축하는 목표를 설정했습니다.",
      "행동: 병목 구간을 계측하고 캐싱·지연로딩·불필요 초기화 제거·빌드 최적화를 적용했습니다.",
      "결과: cold start 42% 단축, 장애 재현/검증 로그 정비, 이후 릴리즈에 재발 방지 체크리스트를 도입했습니다.",
    ].join("\n");
  }
  return answer;
}

function craftFeedbackBlocks({ question, answer, category, score }) {
  const isTech = category === "tech" || category === "architecture";
  const strengths = [], gaps = [], adds = [], pitfalls = [], next = [];

  if (/상황|과제|행동|결과/.test(answer)) strengths.push("STAR 구조를 활용했습니다.");
  if (/(%|ms|qps|배|건|회)/i.test(answer)) strengths.push("정량 지표(%, ms 등)로 효과를 제시했습니다.");
  if (/(계측|프로파일|분석|재현|가설)/.test(answer)) strengths.push("원인 규명/검증 활동을 언급했습니다.");

  if (!/(상황|과제|행동|결과)/.test(answer)) gaps.push("STAR 4문장(상황→과제→행동→결과)으로 분리해 주세요.");
  if (!/(%|ms|qps|배|건|회)/i.test(answer)) gaps.push("전/후 수치 또는 시간/비율 등의 정량 지표를 포함하세요.");
  if (!/(회고|재발|postmortem|prevent)/i.test(answer)) gaps.push("회고와 재발 방지 대책을 1~2문장 추가하세요.");

  if (isTech && !/(프로파일|flame|벤치|bench)/i.test(answer)) adds.push("프로파일/벤치마크 결과를 1~2문장 포함하세요.");
  if (isTech && !/(캐시|cache|배치|batch|큐|queue|샤딩|shard)/i.test(answer)) adds.push("캐시/배치/큐잉/샤딩 등 시스템 레벨 대안을 한 줄 추가하세요.");

  if (/(아마|대충)/.test(answer)) pitfalls.push("추측성 표현을 줄이고 데이터·근거를 먼저 제시하세요.");
  if (/(완벽|절대)/.test(answer)) pitfalls.push("절대적 표현 대신 리스크/한계를 투명하게 언급하세요.");

  if (score >= 85) next.push("핵심만 60초 버전으로 요약해 말하는 연습을 하세요.");
  else if (score >= 70) next.push("전/후 수치·검증·회고를 보강해 80점대까지 끌어올리세요.");
  else next.push("STAR 4문장부터 정확히 정리하고 핵심 지표 2개 이상을 넣어보세요.");

  const summary =
    score >= 85
      ? "원인 규명과 검증이 분명합니다. 60초 압축 버전까지 준비하면 완성도가 높아집니다."
      : score >= 70
      ? "핵심은 잡았으나 지표/검증/회고의 밀도가 부족합니다. STAR와 수치를 보강하세요."
      : "핵심 스토리가 약합니다. STAR로 구조화하고 정량 지표·검증 과정을 추가하세요.";

  return { summary, strengths, gaps, adds, pitfalls, next };
}

function toFeedbackText({ summary, strengths = [], gaps = [], adds = [], pitfalls = [], next = [] }) {
  return [
    `요약: ${summary || ""}`,
    strengths.length ? ["", "■ 잘한 점", ...strengths.map(s => `• ${s}`)].join("\n") : "",
    gaps.length ? ["", "■ 보완 포인트", ...gaps.map(s => `• ${s}`)].join("\n") : "",
    adds.length ? ["", "■ 추가하면 좋은 내용", ...adds.map(s => `• ${s}`)].join("\n") : "",
    pitfalls.length ? ["", "■ 주의할 점", ...pitfalls.map(s => `• ${s}`)].join("\n") : "",
    next.length ? ["", "■ 다음 답변 가이드", ...next.map(s => `• ${s}`)].join("\n") : "",
  ].join("\n").trim();
}

async function gradeAnswer({ company, jobTitle, question, answer }) {
  const category = pickCategory(question);
  const score = scoreAnswer(question, answer);
  const grade = gradeFromScore(score);
  const keywords = extractKeywords(question, answer);
  const polished = craftPolished(answer);
  const blocks = craftFeedbackBlocks({ question, answer, category, score });
  const feedbackText = toFeedbackText(blocks);

  return {
    data: {
      score, grade, category, keywords,
      summary: blocks.summary,
      polished,
      strengths: blocks.strengths,
      gaps: blocks.gaps,
      adds: blocks.adds,
      pitfalls: blocks.pitfalls,
      next: blocks.next,
    },
    feedbackText,
  };
}

module.exports = { gradeAnswer };
