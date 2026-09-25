/**
 * Generate application answers with OpenAI (single pass).
 * Callers must try profile + Q&A bank first; this is last resort.
 *
 * Resume generation uses OPENAI_MODEL (e.g. gpt-4.1).
 * Form understanding / autofill answers use OPENAI_FORM_MODEL (default gpt-4o-mini).
 */

import { chatCompletion, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { selectRelevantProjects, buildProjectAnswerContext } from "./project-manifest.js";
import { renderKbForPrompt } from "./profile-kb.js";

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

const JOB_SPECIFIC_RE =
  /\bwhy (are you|do you|this role|this company|this position|this job|our company|work (here|for us)|join)\b|\b(interest(ed)? in (this|the|our) (role|position|company|job|team)|what (attracts|interests|excites) you|cover letter|about (this|the|our) (role|position|company|opportunity))\b/i;

/**
 * Motivation / fit questions are true for one posting only.
 * A saved answer would be pasted onto the next company.
 */
export function isJobSpecificQuestion(q) {
  const label = String(q?.label || q?.bankQuery || q?.text || "");
  return JOB_SPECIFIC_RE.test(label);
}

/** Store almost everything except long role-specific essays and one-job motivation answers. */
export function shouldBankAnswer(q, answer, fieldType = "") {
  const a = String(answer || "").trim();
  if (!a) return false;
  if (isJobSpecificQuestion(q)) return false;
  const type = String(fieldType || q?.fieldType || "text").toLowerCase();
  if (["select", "combobox", "checkbox", "radio", "choice"].includes(type)) return true;
  if (a.length > 400) return false;
  if (isComplexQuestion(q) && a.length > 160) return false;
  return true;
}

function buildAutofillContext({
  jobMeta = {},
  resumeText = "",
  applicationBrief = null,
  applicantInfo = {},
  knowledgeBase = null
}) {
  const base =
    applicationBrief && typeof applicationBrief === "object"
      ? {
          jobTitle: jobMeta.jobTitle || applicationBrief.jobTitle || "",
          companyName: jobMeta.companyName || applicationBrief.companyName || "",
          applicationBrief: {
            roleSummary: applicationBrief.roleSummary || "",
            topSkills: applicationBrief.topSkills || [],
            keyExperiences: applicationBrief.keyExperiences || [],
            workAuth: applicationBrief.workAuth || "",
            location: applicationBrief.location || ""
          }
        }
      : {
          jobTitle: jobMeta.jobTitle || "",
          companyName: jobMeta.companyName || "",
          jobDescriptionExcerpt: String(jobMeta.jdText || "").trim().slice(0, 3500),
          resumeExcerpt: String(resumeText || "").trim().slice(0, 4000)
        };

  // Real projects from the profile's manifest, ranked against this job. When a
  // brief replaced the JD text above, its summary/skills still carry the signal.
  const relevanceText = [
    jobMeta.jdText || "",
    applicationBrief?.roleSummary || "",
    (applicationBrief?.topSkills || []).join(", ")
  ]
    .filter(Boolean)
    .join("\n");
  const projects = selectRelevantProjects(applicantInfo?.projectManifest, {
    jdText: relevanceText,
    jobTitle: base.jobTitle,
    limit: 5,
    maxChars: 2500
  });
  if (projects.length) {
    base.candidateProjects = buildProjectAnswerContext(projects);
  }
  // Facts the candidate confirmed in their Q&A bank and profile, one per topic.
  const knowledge = renderKbForPrompt(knowledgeBase);
  if (knowledge) base.candidateKnowledge = knowledge;
  return base;
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

/* ------------------------------------------------------------------------- *
 * Answer responsiveness
 *
 * The model used to drift: a textarea made every question "preferLonger", so
 * "When can you start?" got a 60-word experience essay, and "describe your
 * experience with Snowflake" got a generic "why I want to join <company>"
 * paragraph that never mentioned Snowflake. The widget shape is a poor proxy
 * for what a question actually wants, so the question text decides instead, and
 * the answer is checked against it before it reaches the page.
 * ------------------------------------------------------------------------- */

/** Questions that want a date/number/phrase no matter how big the textarea is. */
const SHORT_ANSWER_RE =
  /\b(when (can|could|would) you|start date|starting date|earliest (start|available)|availability|notice period|timeline|how soon|how many|how much|years of|salary|compensation|rate|desired pay|expected pay|date of|what is your (current )?(location|city|address|title))\b/i;

/** "If none, type N/A" — the form itself tells us what to do with no evidence. */
const NA_FALLBACK_RE = /\b(if none|if not applicable|if no experience)\b[^.]*\bn\/?a\b/i;

const SUBJECT_STOPWORDS = new Set([
  "please", "briefly", "describe", "your", "experience", "with", "using", "the", "and",
  "for", "you", "have", "any", "none", "type", "enter", "this", "that", "role", "about",
  "what", "when", "how", "why", "are", "our", "their", "they", "from", "into", "within",
  "working", "work", "worked", "tell", "share", "explain", "summarize", "detail", "details",
  "required", "optional", "answer", "question", "field", "years", "year", "level",
  "industry", "industries", "solutions", "solution", "products", "product", "tools", "tool"
]);

/**
 * Distinctive nouns the answer is expected to actually mention — capitalized
 * terms and acronyms like "Snowflake", "Health & Life Sciences", "FHIR".
 */
function questionSubjects(label) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  // Drop the trailing instruction so 'N/A' is not treated as a subject.
  const core = text.replace(/\bif (none|not applicable|no experience)\b.*$/i, "");
  const out = [];
  const seen = new Set();
  for (const raw of core.match(/[A-Za-z][A-Za-z0-9+#./-]*/g) || []) {
    const token = raw.replace(/[./-]+$/, "");
    const lower = token.toLowerCase();
    if (seen.has(lower) || SUBJECT_STOPWORDS.has(lower) || token.length < 3) continue;
    // Capitalized mid-sentence, or an all-caps acronym: a real subject term.
    const distinctive = /^[A-Z]/.test(token) || /^[A-Z0-9]{2,}$/.test(token);
    if (!distinctive) continue;
    seen.add(lower);
    out.push(token);
  }
  return out.slice(0, 6);
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * What shape this question wants, from its wording first and the widget second.
 * `kind` is the classifier's verdict, which outranks the textarea heuristic.
 */
export function questionAnswerShape(q) {
  const label = String(q?.label || "");
  const kind = String(q?.kind || "").toLowerCase();
  const subjects = questionSubjects(label);
  const allowsNa = NA_FALLBACK_RE.test(label);

  if (kind === "factual" || SHORT_ANSWER_RE.test(label)) {
    return { shape: "short", maxWords: 25, subjects, allowsNa };
  }
  // A one-line <input> physically cannot show a paragraph, so its answer stays
  // brief even when the classifier calls the question "thinking". Only a
  // textarea / rich-text editor earns a long-form answer.
  if (isLongFormQuestion(q)) {
    return { shape: "long", maxWords: 220, subjects, allowsNa };
  }
  if (kind === "thinking") {
    return { shape: "short", maxWords: 45, subjects, allowsNa };
  }
  return { shape: "short", maxWords: 40, subjects, allowsNa };
}

/**
 * Reject an answer that does not actually answer this question.
 * Returns "" when the answer is fine, or a short reason to feed back to the model.
 */
export function answerResponsivenessIssue(q, answer) {
  const text = String(answer || "").trim();
  if (!text) return "empty answer";

  const { shape, maxWords, subjects } = questionAnswerShape(q);
  const words = wordCount(text);

  if (shape === "short" && words > maxWords) {
    return `this question wants a short direct answer (max ~${maxWords} words), not a ${words}-word paragraph`;
  }

  // "Describe your experience with X" must mention X (or say it has none).
  // Short answers are exempt: "Yes", "2 weeks" and "$150,000" are perfectly
  // responsive without repeating the subject back.
  if (shape === "long" && subjects.length) {
    const lower = text.toLowerCase();
    const mentions = subjects.some((s) => lower.includes(s.toLowerCase()));
    const disclaims = /\bn\/?a\b|\bno (direct |hands-on |professional )?experience\b|\bhave not\b|\bnot worked\b/i.test(
      text
    );
    if (!mentions && !disclaims) {
      return `the answer never mentions ${subjects.slice(0, 3).join(", ")}, which is what the question asks about`;
    }
  }

  // Generic motivation filler substituted for a real question.
  if (
    /\b(i am excited about the opportunity|i believe i would be a great fit|i am eager to contribute|thrive in collaborative environments)\b/i.test(
      text
    ) &&
    !/\bwhy\b|\binterest|\bmotivat|\bfit\b/i.test(String(q?.label || ""))
  ) {
    return "this reads like a generic cover-letter paragraph instead of an answer to the question asked";
  }

  return "";
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
  applicationBrief = null,
  knowledgeBase = null
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  if (!list.length) return { answers: [], usage: null };

  // Shape comes from the question wording, not the widget: a short factual
  // question sitting in a textarea must still get a short factual answer.
  const shapeById = new Map(list.map((q) => [q.id, questionAnswerShape(q)]));
  const longForm = list.filter((q) => shapeById.get(q.id).shape === "long");
  const short = list.filter((q) => !longForm.includes(q));
  const chunks = [];
  for (let i = 0; i < longForm.length; i += 6) chunks.push(longForm.slice(i, i + 6));
  for (let i = 0; i < short.length; i += 10) chunks.push(short.slice(i, i + 10));

  const profile = compactApplicantContext(applicantInfo);
  const context = buildAutofillContext({
    jobMeta,
    resumeText,
    applicationBrief,
    applicantInfo,
    knowledgeBase
  });
  const answers = [];
  let usage = null;

  const addUsage = (next) => {
    if (!next) return;
    usage = usage
      ? {
          prompt_tokens: Number(usage.prompt_tokens || 0) + Number(next.prompt_tokens || 0),
          completion_tokens:
            Number(usage.completion_tokens || 0) + Number(next.completion_tokens || 0),
          total_tokens: Number(usage.total_tokens || 0) + Number(next.total_tokens || 0)
        }
      : next;
  };

  const describeQuestion = (q) => {
    const shape = shapeById.get(q.id);
    return {
      id: q.id,
      question: q.label,
      kind: q.kind || (shape.shape === "long" ? "thinking" : "factual"),
      answerShape: shape.shape,
      maxWords: shape.maxWords,
      // The exact terms this answer has to be about, so "experience with
      // Snowflake" cannot come back as a paragraph about the company.
      mustBeAbout: shape.subjects,
      naAllowed: shape.allowsNa
    };
  };

  const askChunk = async (chunk, correction = "") => {
    const hasLongForm = chunk.some((q) => shapeById.get(q.id).shape === "long");
    const messages = [
      {
        role: "system",
        content:
          "You answer US job-application form questions for a real candidate. " +
          'Return ONLY valid JSON: {"answers":[{"id":"...","answer":"..."}]}. ' +
          "Include an answer object for EVERY question id you were given.\n" +
          "CRITICAL — every answer must directly answer ITS OWN question. Never substitute a " +
          "motivation or cover-letter paragraph for a question about a specific technology, " +
          "industry, date, or number.\n" +
          "Obey each question's answerShape:\n" +
          '- answerShape="short": one short phrase or a single sentence, within maxWords. ' +
          "Timelines, start dates, notice periods, salary, and years of experience are SHORT even " +
          "when the field is a big textarea.\n" +
          '- answerShape="long": 2-4 short first-person paragraphs grounded in the resume ' +
          "(90-180 words).\n" +
          "If mustBeAbout is non-empty, the answer must be about exactly those terms and should " +
          "name them. If the resume has no evidence for them, say so briefly and honestly — and " +
          'when naAllowed is true, answer exactly "N/A".\n' +
          "Priority of evidence:\n" +
          "1) candidateKnowledge (facts the candidate confirmed in their Q&A bank and profile) and candidateProfile when the question is factual/identity\n" +
          "2) candidateProjects — real projects this candidate delivered; cite the matching one by what it " +
          "did (stack, scale, outcome) when a question asks about experience with a technology or domain\n" +
          "3) resumeExcerpt for experience, tools, employers, skills\n" +
          "4) jobDescription / applicationBrief ONLY for motivation questions (why this role, why this company, fit)\n" +
          'Yes/No → Title Case "Yes" or "No" only. ' +
          "Do not invent employers, degrees, visas, certifications, tools, or projects absent from the " +
          "resume/profile/candidateProjects. " +
          "Plain text only (no markdown)."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...context,
            candidateProfile: profile,
            questions: chunk.map(describeQuestion)
          },
          null,
          2
        )
      }
    ];
    if (correction) messages.push({ role: "user", content: correction });

    const result = await chatCompletion({
      apiKey,
      model: model || DEFAULT_OPENAI_FORM_MODEL,
      jsonMode: true,
      temperature: hasLongForm ? 0.55 : 0.35,
      maxTokens: hasLongForm ? 3600 : 1800,
      messages
    });
    addUsage(result.usage);
    return answersFromJson(result.content, chunk);
  };

  for (const chunk of chunks) {
    const byId = new Map(chunk.map((q) => [q.id, q]));
    let drafted = await askChunk(chunk);

    // Re-ask only for answers that do not actually answer their question.
    const rejects = [];
    const kept = [];
    for (const row of drafted) {
      const issue = answerResponsivenessIssue(byId.get(row.id), row.answer);
      if (issue) rejects.push({ row, issue });
      else kept.push(row);
    }

    if (rejects.length) {
      const retryList = rejects.map(({ row }) => byId.get(row.id)).filter(Boolean);
      const correction =
        "Your previous answers to these ids were rejected. Rewrite ONLY these, answering the " +
        "actual question this time:\n" +
        rejects
          .map(
            ({ row, issue }) =>
              `- id ${row.id} (question: ${byId.get(row.id)?.label || ""}) — ${issue}.`
          )
          .join("\n");
      let retried = [];
      try {
        retried = await askChunk(retryList, correction);
      } catch {
        retried = [];
      }
      const retriedById = new Map(retried.map((r) => [r.id, r.answer]));
      for (const { row } of rejects) {
        const q = byId.get(row.id);
        const second = retriedById.get(row.id) || "";
        if (second && !answerResponsivenessIssue(q, second)) {
          kept.push({ id: row.id, answer: second });
          continue;
        }
        // Still off-topic. Prefer the form's own escape hatch over a wrong essay,
        // otherwise leave the field blank for the user to fill.
        if (shapeById.get(row.id)?.allowsNa) kept.push({ id: row.id, answer: "N/A" });
      }
    }

    answers.push(...kept);
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
  // Substring matching alone flips meaning: "No, I do not have a disability"
  // is a substring-ish neighbour of the "Yes, I have a disability" option. When
  // both sides lead with Yes/No, that prefix has to agree.
  const lead = (text) => {
    const t = String(text).trim().toLowerCase();
    if (/^y(es)?\b/.test(t)) return "yes";
    if (/^n(o)?\b/.test(t)) return "no";
    return "";
  };
  const wantLead = lead(want);
  for (const opt of options) {
    const optNorm = String(opt).trim().toLowerCase();
    const optLead = lead(opt);
    if (wantLead && optLead && wantLead !== optLead) continue;
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
  applicationBrief = null,
  knowledgeBase = null
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
          "Some questions carry previousAnswer: what this candidate answered the same question before, on a form that worded its options differently. " +
          "Treat it as the candidate's real position and map it to the option that means the SAME thing. " +
          "Watch negation — 'No, I do not have a disability' and 'Yes, I have a disability' are opposites even though they share most words. " +
          "If no option carries that meaning, omit the question rather than guessing.\n" +
          "Evidence order: (1) candidateKnowledge — facts the candidate confirmed in their Q&A bank and profile — and candidateProfile, (2) candidateProjects — real projects the candidate delivered, which settle questions about hands-on experience with a technology or domain, (3) resumeExcerpt, (4) job description only when the question is about role fit.\n" +
          "Default guidance when profile is silent: eligible to work in the US → Yes; visa sponsorship needed → No; " +
          "employment restrictions with current/former employer → No; previously worked for this company → No; " +
          "related to current employee → No; government employee → No; ethics recusal → No. " +
          'Return ONLY JSON: {"answers":[{"id":"...","answer":"..."}]}.'
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...buildAutofillContext({
              jobMeta,
              resumeText,
              applicationBrief,
              applicantInfo,
              knowledgeBase
            }),
            candidateProfile: profile,
            questions: list.map((q) => ({
              id: q.id,
              question: q.label,
              kind: q.kind || "choice",
              fieldType: q.fieldType || "select",
              // The Q&A bank's answer for this question when it did not appear
              // verbatim in this form's option list.
              ...(q.bankAnswer ? { previousAnswer: q.bankAnswer } : null),
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
