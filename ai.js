// ai.js (Full Safe Version)

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

async function gradeAnswer({ company, jobTitle, question, answer }) {
  try {
    console.log("🔥 gradeAnswer START");

    const model = process.env.AI_MODEL || "gpt-4o-mini";

    const systemPrompt = `
당신은 실리콘밸리 기술면접관 + 시니어 코치입니다.
절대 장황하게 설명하지 말고 JSON만 생성하십시오.
    `;

    const userPrompt = `
【질문】 ${question}
【직무】 ${jobTitle}
【기업】 ${company}

【답변】
${answer}

JSON ONLY:
{
  "score": 0,
  "grade": "A",
  "summary_interviewer": "...",
  "summary_coach": "...",
  "strengths": [],
  "gaps": [],
  "adds": [],
  "pitfalls": [],
  "next": [],
  "keywords": [],
  "category": "general",
  "polished": ""
}
`;

    // 🔥 OpenAI API 호출
    const response = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    console.log("🔥 gradeAnswer GOT RESPONSE");

    let raw = response?.choices?.[0]?.message?.content;
    let data;

    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error("⚠ JSON Parse Error:", raw);

      data = {
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
        polished: ""
      };
    }

    data.category = data.category || pickCategory(question);

    return {
      data,
      feedbackText: buildFeedbackText(data),
    };

  } catch (err) {
    console.error("🔥 gradeAnswer FAILED:", err);

    // 🎯 서버가 절대 멈추지 않도록 fallback 응답 제공
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
      category: "general",
      polished: ""
    };

    return {
      data: fallback,
      feedbackText: "AI 채점 중 오류가 발생했습니다."
    };
  }
}

function buildFeedbackText(ai) {
  return [
    `면접관 요약: ${ai.summary_interviewer}`,
    `코치 요약: ${ai.summary_coach}`,
    "",
    "■ Strengths",
    ...(ai.strengths || []).map(s => `• ${s}`),
    "",
    "■ Gaps",
    ...(ai.gaps || []).map(s => `• ${s}`),
    "",
    "■ Adds",
    ...(ai.adds || []).map(s => `• ${s}`),
    "",
    "■ Pitfalls",
    ...(ai.pitfalls || []).map(p => {
      if (!p || typeof p !== "object") return "• (레벨 N/A) 내용 없음";
      return `• (레벨 ${p.level ?? "N/A"}) ${p.text ?? ""}`;
    }),
    "",
    "■ Next Steps",
    ...(ai.next || []).map(s => `• ${s}`),
    "",
    "■ Polished",
    ai.polished || ""
  ].join("\n");
}

module.exports = { gradeAnswer };
