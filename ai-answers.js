/**
 * Generate brief application answers with OpenAI, then humanize them.
 */

import { chatCompletion, DEFAULT_OPENAI_MODEL } from "./openai.js";

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function compactApplicantContext(applicantInfo = {}) {
  const keys = [
    "firstName",
    "lastName",
    "preferredName",
    "email",
    "phone",
    "city",
    "state",
    "country",
    "yearsExperience",
    "relevantExperience",
    "highestDegree",
    "schoolName",
    "fieldOfStudy",
    "workAuthorized",
    "needsSponsorship",
    "salaryExpectation",
    "earliestStartDate",
    "whyInterested",
    "linkedinUrl"
  ];
  const out = {};
  for (const key of keys) {
    const value = applicantInfo[key];
    if (value != null && String(value).trim()) out[key] = String(value).trim();
  }
  return out;
}

/**
 * @param {{
 *   apiKey: string,
 *   model?: string,
 *   questions: Array<{ id: string, label: string, multiline?: boolean }>,
 *   applicantInfo: object,
 *   jobMeta?: { jobTitle?: string, companyName?: string, jdText?: string },
 *   resumeText?: string
 * }} opts
 * @returns {Promise<Array<{ id: string, answer: string }>>}
 */
export async function generateHumanizedApplicationAnswers({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  questions,
  applicantInfo,
  jobMeta = {},
  resumeText = ""
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label).slice(0, 10);
  if (!list.length) return [];

  const profile = compactApplicantContext(applicantInfo);
  const jdSnippet = String(jobMeta.jdText || "").trim().slice(0, 3500);
  const resumeSnippet = String(resumeText || "").trim().slice(0, 4000);

  const draftRaw = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.65,
    maxTokens: 1800,
    messages: [
      {
        role: "system",
        content:
          "You answer US job-application form questions for a real candidate. " +
          "Return ONLY valid JSON: {\"answers\":[{\"id\":\"...\",\"answer\":\"...\"}]}. " +
          "Keep each answer to 1-2 sentences max (a short phrase for tiny fields). " +
          "If the question requires a specific opening phrase, begin the answer with that phrase exactly. " +
          "Ground answers in the candidate resume and profile; prefer real roles, employers, tools, and skills from the resume. " +
          "Do not invent employers, degrees, visas, or tools that contradict the resume/profile. " +
          "If the resume lacks a specific story the question asks for, give a cautious brief answer based on transferable experience — do not fabricate a detailed false project."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            jobTitle: jobMeta.jobTitle || "",
            companyName: jobMeta.companyName || "",
            jobDescriptionExcerpt: jdSnippet,
            resumeExcerpt: resumeSnippet,
            candidateProfile: profile,
            questions: list.map((q) => ({
              id: q.id,
              question: q.label,
              preferLonger: Boolean(q.multiline)
            }))
          },
          null,
          2
        )
      }
    ]
  });

  const draftObj = parseJsonObject(draftRaw);
  const draftAnswers = Array.isArray(draftObj?.answers) ? draftObj.answers : [];

  const humanRaw = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.9,
    maxTokens: 1800,
    messages: [
      {
        role: "system",
        content:
          "You rewrite job-application answers so they sound like a real person typed them. " +
          "Keep the same meaning and stay within 1-2 sentences (or a short phrase for tiny fields). " +
          "Preserve any required opening phrase at the start of an answer. " +
          "Use natural wording, slight contractions when fitting, and avoid buzzwords, filler, or robotic phrasing. " +
          "Do not add markdown, quotes around the whole answer, or explanations. " +
          "Return ONLY JSON: {\"answers\":[{\"id\":\"...\",\"answer\":\"...\"}]}."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            instruction:
              "Humanize each answer. Preserve id values exactly. Keep answers to 1-2 sentences and application-appropriate.",
            answers: draftAnswers.map((a) => ({
              id: a.id,
              answer: a.answer,
              question: list.find((q) => q.id === a.id)?.label || ""
            }))
          },
          null,
          2
        )
      }
    ]
  });

  const humanObj = parseJsonObject(humanRaw);
  const humanAnswers = Array.isArray(humanObj?.answers) ? humanObj.answers : draftAnswers;

  const byId = new Map();
  for (const row of humanAnswers) {
    const id = String(row?.id || "").trim();
    const answer = String(row?.answer || "").trim();
    if (!id || !answer) continue;
    byId.set(id, answer);
  }

  // Fallback to draft if humanize dropped an id.
  for (const row of draftAnswers) {
    const id = String(row?.id || "").trim();
    const answer = String(row?.answer || "").trim();
    if (id && answer && !byId.has(id)) byId.set(id, answer);
  }

  return list
    .map((q) => ({ id: q.id, answer: byId.get(q.id) || "" }))
    .filter((row) => row.answer);
}
