/**
 * Generate application answers with OpenAI (single pass).
 * Callers must try profile + Q&A bank first; this is last resort.
 *
 * Resume generation uses OPENAI_MODEL (e.g. gpt-4.1).
 * Form understanding / autofill answers use OPENAI_FORM_MODEL (default gpt-4o-mini).
 */

import { chatCompletion, DEFAULT_OPENAI_MODEL } from "./openai.js";

/** Cheap, fast model for form classification + application answers. */
export const DEFAULT_OPENAI_FORM_MODEL = "gpt-4o-mini";

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

const FORM_KINDS = new Set(["identity", "factual", "choice", "thinking", "skip"]);

/**
 * Use gpt-4o-mini (or OPENAI_FORM_MODEL) to understand each field before answering.
 * Returns a Map of question id → { kind, bankQuery, reason }.
 *
 * kinds:
 * - identity: name/email/phone/address — profile autofill already owns these; skip AI
 * - factual: reusable short facts — prefer Q&A bank, then short AI
 * - choice: dropdown/radio/checkbox — bank then constrained AI
 * - thinking: needs JD + resume reasoning (why this role, experience essays, etc.)
 * - skip: captcha/search/password/file/unrelated — do not fill
 */
export async function classifyApplicationQuestions({
  apiKey,
  model = DEFAULT_OPENAI_FORM_MODEL,
  questions = []
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label).slice(0, 40);
  const byId = new Map();
  if (!list.length) return byId;

  // Heuristic defaults so we still progress if the classifier fails.
  for (const q of list) {
    let kind = "factual";
    if (isComplexQuestion(q) || isLongFormQuestion(q)) kind = "thinking";
    else if (
      ["select", "combobox", "checkbox", "radio"].includes(String(q.fieldType || "").toLowerCase()) ||
      (Array.isArray(q.options) && q.options.length)
    ) {
      kind = "choice";
    }
    byId.set(q.id, { kind, bankQuery: String(q.label || "").trim(), reason: "heuristic" });
  }

  try {
    const result = await chatCompletion({
      apiKey,
      model: model || DEFAULT_OPENAI_FORM_MODEL,
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 2000,
      messages: [
        {
          role: "system",
          content:
            "You classify US job-application form fields so an autofill bot answers the RIGHT question. " +
            "Return ONLY JSON: {\"fields\":[{\"id\":\"...\",\"kind\":\"identity|factual|choice|thinking|skip\",\"bankQuery\":\"short canonical question\",\"reason\":\"...\"}]}. " +
            "Include every id you were given.\n" +
            "kind meanings:\n" +
            "- identity: first/last name, email, phone, address, city, state, zip, LinkedIn, password, username login\n" +
            "- factual: short reusable facts (work auth, sponsorship, years experience, degree, salary, start date, yes/no screening)\n" +
            "- choice: must pick from provided options (dropdown/radio/checkbox/combobox)\n" +
            "- thinking: needs reasoning from the job description + resume (why this company, describe experience, challenges, cover-letter style)\n" +
            "- skip: captcha, OTP, search boxes, file upload, unrelated marketing, fields that must stay empty\n" +
            "bankQuery: a short cleaned question text good for matching a Q&A bank (strip 'required', placeholders, ATS noise). " +
            "Do NOT invent answers. Only classify."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              fields: list.map((q) => ({
                id: q.id,
                question: q.label,
                fieldType: q.fieldType || (isLongFormQuestion(q) ? "textarea" : "text"),
                hasOptions: Array.isArray(q.options) && q.options.length > 0,
                optionCount: Array.isArray(q.options) ? q.options.length : 0,
                multiline: Boolean(q.multiline || q.richText)
              }))
            },
            null,
            2
          )
        }
      ]
    });
    const obj = parseJsonObject(result.content);
    const rows = Array.isArray(obj?.fields) ? obj.fields : [];
    for (const row of rows) {
      const id = String(row?.id || "").trim();
      if (!id || !byId.has(id)) continue;
      const kind = FORM_KINDS.has(String(row?.kind || "").toLowerCase())
        ? String(row.kind).toLowerCase()
        : byId.get(id).kind;
      const bankQuery = String(row?.bankQuery || byId.get(id).bankQuery || "").trim();
      byId.set(id, {
        kind,
        bankQuery: bankQuery || byId.get(id).bankQuery,
        reason: String(row?.reason || "classifier").slice(0, 200),
        usage: result.usage || null
      });
    }
    // Attach usage once on a sentinel for the caller
    byId._usage = result.usage || null;
  } catch {
    /* keep heuristic map */
  }

  return byId;
}

/**
 * @returns {Promise<{ answers: Array<{ id: string, answer: string }>, usage: object }>}
 */
export async function generateHumanizedApplicationAnswers({
  apiKey,
  model = DEFAULT_OPENAI_FORM_MODEL,
  questions,
  applicantInfo,
  jobMeta = {},
  resumeText = "",
  applicationBrief = null
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  if (!list.length) return { answers: [], usage: null };

  const longForm = list.filter((q) => isLongFormQuestion(q) || q?.kind === "thinking");
  const short = list.filter((q) => !longForm.includes(q));
  const chunks = [];
  for (let i = 0; i < longForm.length; i += 6) chunks.push(longForm.slice(i, i + 6));
  for (let i = 0; i < short.length; i += 10) chunks.push(short.slice(i, i + 10));

  const profile = compactApplicantContext(applicantInfo);
  const answers = [];
  let usage = null;

  for (const chunk of chunks) {
    const hasLongForm = chunk.some((q) => isLongFormQuestion(q) || q?.kind === "thinking");
    const result = await chatCompletion({
      apiKey,
      model: model || DEFAULT_OPENAI_FORM_MODEL,
      jsonMode: true,
      temperature: hasLongForm ? 0.55 : 0.35,
      maxTokens: hasLongForm ? 3600 : 1800,
      messages: [
        {
          role: "system",
          content:
            "You answer US job-application form questions for a real candidate. " +
            "Return ONLY valid JSON: {\"answers\":[{\"id\":\"...\",\"answer\":\"...\"}]}. " +
            "Include an answer object for EVERY question id you were given.\n" +
            "CRITICAL — answer the exact question asked; do not put a JD essay into a yes/no or short factual field.\n" +
            "Priority of evidence:\n" +
            "1) candidateProfile facts when the question is factual/identity\n" +
            "2) resumeExcerpt for experience, tools, employers, skills\n" +
            "3) jobDescription / applicationBrief ONLY for thinking questions (why this role, fit, motivation)\n" +
            "For kind=thinking or preferLonger: write 2-4 short first-person paragraphs grounded in resume + JD (90-180 words). " +
            "For kind=factual / short fields: 1 sentence or a short phrase only.\n" +
            "Yes/No → Title Case \"Yes\" or \"No\" only. " +
            "Do not invent employers, degrees, visas, certifications, or tools absent from the resume/profile. " +
            "If evidence is missing, give a cautious brief answer — never fabricate a detailed false project. " +
            "Plain text only (no markdown)."
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
                kind: q.kind || (isLongFormQuestion(q) ? "thinking" : "factual"),
                preferLonger: isLongFormQuestion(q) || q?.kind === "thinking"
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
  model = DEFAULT_OPENAI_FORM_MODEL,
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
    model: model || DEFAULT_OPENAI_FORM_MODEL,
    jsonMode: true,
    temperature: 0.15,
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content:
          "You answer US job-application CHOICE questions for a real candidate. " +
          "Questions may be select dropdowns, radio groups, checkboxes, or comboboxes (fieldType). " +
          "Each question includes an options array — you MUST set answer to EXACTLY one string from that question's options (character-for-character). " +
          "Never invent an option. Read the question carefully and pick the option that matches THAT question — do not reuse an answer meant for a different field.\n" +
          "Evidence order: (1) Q&A-style facts already in candidateProfile, (2) resumeExcerpt, (3) job description only when the question is about role fit.\n" +
          "Default guidance when profile is silent: eligible to work in the US → Yes; visa sponsorship needed → No; " +
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
              kind: q.kind || "choice",
              fieldType: q.fieldType || "select",
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
