/**
 * Generate application answers with OpenAI (single pass).
 * Callers must try profile + Q&A bank first; this is last resort.
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

export function compactApplicantContext(applicantInfo = {}) {
  const keys = [
    "firstName",
    "lastName",
    "preferredName",
    "email",
    "phone",
    "city",
    "state",
    "country",
    "cityCountryOfResidence",
    "yearsExperience",
    "relevantExperience",
    "englishLevel",
    "highestDegree",
    "schoolName",
    "fieldOfStudy",
    "workAuthorized",
    "needsSponsorship",
    "postEmploymentRestrictions",
    "salaryExpectation",
    "earliestStartDate",
    "whyInterested",
    "linkedinUrl",
    "gender",
    "hispanicLatino",
    "raceEthnicity",
    "veteranStatus",
    "disabilityStatus"
  ];
  const out = {};
  for (const key of keys) {
    const value = applicantInfo[key];
    if (value != null && String(value).trim()) out[key] = String(value).trim();
  }
  return out;
}

const COMPLEX_RE =
  /\b(tell|describe|explain|share|summarize|walk)\b|\bwhy (are you|do you|this role|this company|this position|this job)\b|\b(most challenging|about yourself|motivation|cover letter|relevant experience)\b/i;

/** JD-specific essays — always AI per job, never stored in the Q&A bank. */
export function isComplexQuestion(q) {
  const label = String(q?.label || "");
  const longForm = Boolean(
    q?.multiline || q?.richText || q?.fieldType === "richtext" || q?.fieldType === "textarea"
  );
  if (q?.richText || q?.fieldType === "richtext") return true;
  if (longForm && COMPLEX_RE.test(label)) return true;
  if (label.length > 220 && COMPLEX_RE.test(label)) return true;
  if (longForm && label.length > 120) return true;
  return false;
}

/** Store almost everything except long role-specific essays. */
export function shouldBankAnswer(q, answer, fieldType = "") {
  const a = String(answer || "").trim();
  if (!a) return false;
  const type = String(fieldType || q?.fieldType || "text").toLowerCase();
  if (["select", "combobox", "checkbox", "radio", "choice"].includes(type)) return true;
  if (a.length > 400) return false;
  if (isComplexQuestion(q) && a.length > 160) return false;
  return true;
}

function buildAutofillContext({ jobMeta = {}, resumeText = "", applicationBrief = null }) {
  if (applicationBrief && typeof applicationBrief === "object") {
    return {
      jobTitle: jobMeta.jobTitle || applicationBrief.jobTitle || "",
      companyName: jobMeta.companyName || applicationBrief.companyName || "",
      applicationBrief: {
        roleSummary: applicationBrief.roleSummary || "",
        topSkills: applicationBrief.topSkills || [],
        keyExperiences: applicationBrief.keyExperiences || [],
        workAuth: applicationBrief.workAuth || "",
        location: applicationBrief.location || ""
      }
    };
  }
  return {
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || "",
    jobDescriptionExcerpt: String(jobMeta.jdText || "").trim().slice(0, 3500),
    resumeExcerpt: String(resumeText || "").trim().slice(0, 4000)
  };
}

function answersFromJson(raw, list) {
  const text = typeof raw === "string" ? raw : raw?.content || "";
  const obj = parseJsonObject(text);
  const rows = Array.isArray(obj?.answers) ? obj.answers : [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    const answer = String(row?.answer || "").trim();
    if (!id || !answer) continue;
    byId.set(id, answer);
  }
  return list
    .map((q) => ({ id: q.id, answer: byId.get(q.id) || "" }))
    .filter((row) => row.answer);
}

function isLongFormQuestion(q) {
  return Boolean(
    q?.multiline || q?.richText || q?.fieldType === "richtext" || q?.fieldType === "textarea"
  );
}

/**
 * @returns {Promise<{ answers: Array<{ id: string, answer: string }>, usage: object }>}
 */
export async function generateHumanizedApplicationAnswers({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  questions,
  applicantInfo,
  jobMeta = {},
  resumeText = "",
  applicationBrief = null
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  if (!list.length) return { answers: [], usage: null };

  const longForm = list.filter(isLongFormQuestion);
  const short = list.filter((q) => !isLongFormQuestion(q));
  const chunks = [];
  for (let i = 0; i < longForm.length; i += 6) chunks.push(longForm.slice(i, i + 6));
  for (let i = 0; i < short.length; i += 10) chunks.push(short.slice(i, i + 10));

  const profile = compactApplicantContext(applicantInfo);
  const answers = [];
  let usage = null;

  for (const chunk of chunks) {
    const hasLongForm = chunk.some(isLongFormQuestion);
    const result = await chatCompletion({
      apiKey,
      model,
      jsonMode: true,
      temperature: 0.65,
      maxTokens: hasLongForm ? 3600 : 1800,
      messages: [
        {
          role: "system",
          content:
            "You answer US job-application form questions for a real candidate. " +
            "Return ONLY valid JSON: {\"answers\":[{\"id\":\"...\",\"answer\":\"...\"}]}. " +
            "Include an answer object for EVERY question id you were given. " +
            "For short fields keep each answer to 1-2 sentences (a short phrase for tiny fields). " +
            "If a question asks which certifications/credentials you hold, name them directly from the resume (or say you do not hold that specific cert). " +
            "For questions marked preferLonger, write 2-4 short paragraphs (about 90-180 words) in first person, " +
            "grounded in the resume — concrete tools, employers, and decisions, no buzzword padding. " +
            "For yes/no style answers use Title Case exactly: \"Yes\" or \"No\" (never lowercase). " +
            "If the question requires a specific opening phrase, begin the answer with that phrase exactly. " +
            "Ground answers in the candidate resume/profile/brief; prefer real roles, employers, tools, and skills. " +
            "Do not invent employers, degrees, visas, or tools that contradict the resume/profile. " +
            "If the resume lacks a specific story the question asks for, give a cautious brief answer based on transferable experience — do not fabricate a detailed false project. " +
            "Use plain text only (no markdown headings)."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              ...buildAutofillContext({ jobMeta, resumeText, applicationBrief }),
              candidateProfile: profile,
              questions: chunk.map((q) => ({
                id: q.id,
                question: q.label,
                preferLonger: isLongFormQuestion(q)
              }))
            },
            null,
            2
          )
        }
      ]
    });
    answers.push(...answersFromJson(result.content, chunk));
    if (result.usage) {
      usage = usage
        ? {
            prompt_tokens: Number(usage.prompt_tokens || 0) + Number(result.usage.prompt_tokens || 0),
            completion_tokens:
              Number(usage.completion_tokens || 0) + Number(result.usage.completion_tokens || 0),
            total_tokens: Number(usage.total_tokens || 0) + Number(result.usage.total_tokens || 0)
          }
        : result.usage;
    }
  }

  return { answers, usage };
}

function pickClosestOption(answer, options = []) {
  const want = String(answer || "").trim();
  if (!want || !options.length) return "";
  const wantNorm = want.toLowerCase();
  for (const opt of options) {
    if (String(opt).trim().toLowerCase() === wantNorm) return opt;
  }
  for (const opt of options) {
    const optNorm = String(opt).trim().toLowerCase();
    if (optNorm.includes(wantNorm) || wantNorm.includes(optNorm)) return opt;
  }
  if (/^yes\b/i.test(want)) {
    const yesOpt = options.find((o) => /^yes\b/i.test(String(o).trim()));
    if (yesOpt) return yesOpt;
  }
  if (/^no\b/i.test(want)) {
    const noOpt = options.find((o) => /^no\b/i.test(String(o).trim()));
    if (noOpt) return noOpt;
  }
  return "";
}

/**
 * @returns {Promise<{ answers: Array<{ id: string, answer: string }>, usage: object }>}
 */
export async function generateConstrainedChoiceAnswers({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  questions,
  applicantInfo,
  jobMeta = {},
  resumeText = "",
  applicationBrief = null
}) {
  const list = (questions || [])
    .filter((q) => q?.id && q?.label && Array.isArray(q.options) && q.options.length)
    .slice(0, 12);
  if (!list.length) return { answers: [], usage: null };

  const profile = compactApplicantContext(applicantInfo);
  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content:
          "You answer US job-application CHOICE questions for a real candidate. " +
          "Each question includes an options array — you MUST set answer to EXACTLY one string from that question's options (character-for-character). " +
          "Never invent an option. For yes/no style questions prefer honest answers from the profile/resume. " +
          "Default guidance when profile is silent: eligible to work in the US → Yes option; visa sponsorship needed → No; " +
          "employment restrictions with current/former employer → No; previously worked for this company → No; " +
          "related to current employee → No; government employee → No; ethics recusal → No. " +
          'Return ONLY JSON: {"answers":[{"id":"...","answer":"..."}]}.'
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...buildAutofillContext({ jobMeta, resumeText, applicationBrief }),
            candidateProfile: profile,
            questions: list.map((q) => ({
              id: q.id,
              question: q.label,
              options: q.options
            }))
          },
          null,
          2
        )
      }
    ]
  });

  const drafted = answersFromJson(result.content, list);
  const answers = drafted
    .map((row) => {
      const q = list.find((item) => item.id === row.id);
      const matched = pickClosestOption(row.answer, q?.options || []);
      return { id: row.id, answer: matched };
    })
    .filter((row) => row.answer);

  return { answers, usage: result.usage };
}

/**
 * Humanized first-person summaries for repeating Work Experience form fields.
 * One short paragraph per role — not a bullet dump.
 */
export async function generateRoleSummaries({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  jobs = [],
  jobMeta = {}
} = {}) {
  const list = (jobs || [])
    .map((job, index) => ({
      index: Number.isInteger(job?.index) ? job.index : index,
      company: String(job?.company || "").trim(),
      title: String(job?.title || "").trim(),
      dates: String(job?.dates || "").trim(),
      current: Boolean(job?.current),
      bullets: Array.isArray(job?.bullets) ? job.bullets.filter(Boolean).slice(0, 6) : [],
      existing: String(job?.summary || "").trim()
    }))
    .filter((job) => job.company || job.title);
  if (!list.length) return { summaries: [], usage: null };

  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.55,
    maxTokens: 2200,
    messages: [
      {
        role: "system",
        content:
          "You write short human job-application role summaries. " +
          'Return ONLY JSON: {"summaries":[{"index":0,"summary":"..."}]}. ' +
          "Each summary is 2-4 sentences in first person, natural and specific, not a bullet list. " +
          "Use past tense for previous roles and present tense for the current role. " +
          "Ground every sentence in the provided bullets, tools, and employer. " +
          "Do not invent employers, titles, or technologies. Do not copy the job description. " +
          "Keep each summary under 700 characters."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            targetJobTitle: jobMeta.jobTitle || "",
            targetCompany: jobMeta.companyName || "",
            jobDescriptionExcerpt: String(jobMeta.jdText || "").trim().slice(0, 1800),
            roles: list.map((job) => ({
              index: job.index,
              company: job.company,
              title: job.title,
              dates: job.dates,
              current: job.current,
              bullets: job.bullets
            }))
          },
          null,
          2
        )
      }
    ]
  });

  const obj = parseJsonObject(result.content);
  const rows = Array.isArray(obj?.summaries) ? obj.summaries : [];
  const byIndex = new Map();
  for (const row of rows) {
    const index = Number(row?.index);
    const summary = String(row?.summary || "").trim();
    if (!Number.isInteger(index) || !summary) continue;
    byIndex.set(index, summary.slice(0, 900));
  }

  const summaries = list.map((job) => ({
    index: job.index,
    summary: byIndex.get(job.index) || job.existing
  }));

  return { summaries, usage: result.usage };
}
