/**
 * AI form planner.
 *
 * The content script scans a whole application step — every empty field, its
 * widget kind, label, section, required flag and, for choice widgets, the exact
 * options — and this module answers all of them in one pass from:
 *   1. the profile knowledge base (profile-kb.js),
 *   2. the closest Q&A bank answers for each field,
 *   3. the resume and project manifest,
 *   4. the job description (fit and motivation questions only).
 *
 * Seeing the whole form at once is what lets the model keep answers consistent
 * ("authorized to work" vs "needs sponsorship"), map one fact onto whatever
 * wording a dropdown uses, and leave alone what an optional field does not need.
 *
 * Every reply is checked before it reaches the page: a choice must land on a
 * real option, and an essay must answer its own question.
 *
 * Used only from the background service worker.
 */

import { chatCompletion, parseJsonReply } from "./openai.js";
import {
  compactApplicantContext,
  questionAnswerShape,
  answerResponsivenessIssue
} from "./ai-answers.js";
import { selectRelevantProjects, buildProjectAnswerContext } from "./project-manifest.js";
import { renderKbForPrompt } from "./profile-kb.js";

const FIELD_KINDS = new Set([
  "text",
  "textarea",
  "richtext",
  "select",
  "radio",
  "checkbox",
  "checkbox_group",
  "combobox"
]);
const CHOICE_KINDS = new Set(["select", "radio", "combobox", "checkbox_group", "checkbox"]);
const LONG_KINDS = new Set(["textarea", "richtext"]);
const ANSWER_SOURCES = new Set(["kb", "qa", "profile", "resume", "jd", "default"]);

/** Choice lists longer than this are trimmed to their likely candidates in the prompt. */
const PROMPT_OPTION_LIMIT = 60;
const SHORT_CHUNK = 30;
const LONG_CHUNK = 5;
const MAX_PARALLEL_CALLS = 2;

/** Labels that want a datum, never a bare Yes/No. */
const NOT_YES_NO_LABEL_RE =
  /\b(name|email|e mail|phone|address|city|state|zip|postal|country|url|link|website|date|salary|compensation|years|number|title|company|employer|school)\b/;
const NEGATION_RE = /\b(not|no|non|never|decline|dont|don t|do not|does not|am not|prefer not)\b/;

export function isChoiceKind(kind) {
  return CHOICE_KINDS.has(kind);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function leadYesNo(norm) {
  if (/^yes\b|^y$/.test(norm)) return "yes";
  if (/^no\b|^n$/.test(norm)) return "no";
  return "";
}

/**
 * The option that means the same as `value`, or "".
 *
 * Exact text first. After that the Yes/No lead must agree and a negation must be
 * on both sides or neither — plain substring or token matching would map "No"
 * onto "None of the above", or "I am not a protected veteran" onto "I am a
 * protected veteran". Then whole-word containment, then token overlap.
 */
export function matchOption(value, options = []) {
  const want = normalizeText(value);
  if (!want || !options.length) return "";
  const exact = options.find((o) => normalizeText(o) === want);
  if (exact) return exact;

  const wantLead = leadYesNo(want);
  const wantNeg = NEGATION_RE.test(want);
  const pool = options.filter((o) => {
    const on = normalizeText(o);
    const optLead = leadYesNo(on);
    return on && !(wantLead && optLead && wantLead !== optLead);
  });
  if (want === "yes" || want === "no") {
    return pool.find((o) => leadYesNo(normalizeText(o)) === want) || "";
  }
  const sameNegation = pool.filter((o) => NEGATION_RE.test(normalizeText(o)) === wantNeg);

  const hasWord = (hay, needle) => new RegExp(`(^| )${escapeRegExp(needle)}( |$)`).test(hay);
  const contained = sameNegation.filter((o) => {
    const on = normalizeText(o);
    return hasWord(on, want) || hasWord(want, on);
  });
  if (contained.length) {
    // "United States" must land on "United States", not "United States Minor Outlying Islands".
    contained.sort(
      (a, b) =>
        Math.abs(normalizeText(a).length - want.length) -
        Math.abs(normalizeText(b).length - want.length)
    );
    return contained[0];
  }

  const wantTokens = want.split(" ").filter((t) => t.length > 2);
  if (!wantTokens.length) return "";
  let best = "";
  let bestScore = 0;
  for (const o of sameNegation) {
    const optTokens = new Set(normalizeText(o).split(" ").filter((t) => t.length > 2));
    if (!optTokens.size) continue;
    const hits = wantTokens.filter((t) => optTokens.has(t)).length;
    const score = hits / Math.max(wantTokens.length, optTokens.size);
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return bestScore >= 0.6 ? best : "";
}

/**
 * A country or state dropdown can hold 250 options. Send the ones the evidence
 * points at plus the head of the list; the full list stays here for matching.
 */
function promptOptions(options, hints) {
  if (options.length <= PROMPT_OPTION_LIMIT) return { options, truncated: false };
  const hintNorms = hints.map(normalizeText).filter((h) => h.length >= 2);
  const picked = [];
  const seen = new Set();
  const add = (o) => {
    if (seen.has(o) || picked.length >= PROMPT_OPTION_LIMIT) return;
    seen.add(o);
    picked.push(o);
  };
  for (const o of options) {
    const on = normalizeText(o);
    if (hintNorms.some((h) => on === h || on.includes(h) || (on.length > 3 && h.includes(on)))) {
      add(o);
    }
  }
  for (const o of options.slice(0, 15)) add(o);
  return { options: picked, truncated: true };
}

/** Evidence words that are likely to name the right option in a long list. */
function makeHintPool(knowledgeBase, applicantInfo = {}) {
  const generic = ["country", "state", "city", "schoolName", "fieldOfStudy", "highestDegree"]
    .map((k) => String(applicantInfo?.[k] || "").trim())
    .filter(Boolean);
  const facts = Array.isArray(knowledgeBase?.facts) ? knowledgeBase.facts : [];
  return (field) => {
    const labelTokens = new Set(normalizeText(field.label).split(" ").filter((t) => t.length > 3));
    const related = facts
      .filter((f) =>
        normalizeText(`${f.topic} ${f.question}`)
          .split(" ")
          .some((t) => t.length > 3 && labelTokens.has(t))
      )
      .map((f) => f.answer);
    return [...generic, ...related.slice(0, 8)];
  };
}

function shapeFor(field) {
  return questionAnswerShape({
    label: field.label,
    multiline: LONG_KINDS.has(field.kind),
    richText: field.kind === "richtext",
    fieldType: field.kind
  });
}

function describeField(field, { bankMatches, hintPool }) {
  const out = { id: field.id, kind: field.kind, label: field.label };
  if (field.section && normalizeText(field.section) !== normalizeText(field.label)) {
    out.section = field.section;
  }
  if (field.required) out.required = true;
  if (field.inputType && field.inputType !== "text") out.inputType = field.inputType;
  if (field.placeholder) out.placeholder = field.placeholder;
  if (field.maxLength) out.maxLength = field.maxLength;
  if (field.multiple) out.multiple = true;
  if (field.optionsAsync) out.optionsAsync = true;
  if (field.help) out.help = field.help;

  const matches = bankMatches.get(field.id) || [];
  if (Array.isArray(field.options) && field.options.length) {
    const hints = [field.profileHint, ...matches.map((m) => m.record.answer), ...hintPool(field)]
      .filter(Boolean)
      .map(String);
    const { options, truncated } = promptOptions(field.options, hints);
    out.options = options;
    if (truncated) {
      out.optionsTruncated = true;
      out.optionCount = field.options.length;
    }
  }
  if (field.profileHint) out.profileHint = field.profileHint;
  if (matches.length) {
    out.bankMatches = matches.map((m) => ({
      q: String(m.record.question || "").slice(0, 200),
      a: String(m.record.answer || "").slice(0, 300),
      ...(String(m.record.source || "") === "ai" ? { unverified: true } : null)
    }));
  }
  if (LONG_KINDS.has(field.kind)) {
    const shape = shapeFor(field);
    out.answerShape = shape.shape;
    out.maxWords = shape.maxWords;
    if (shape.subjects.length) out.mustBeAbout = shape.subjects;
    if (shape.allowsNa) out.naAllowed = true;
  }
  return out;
}

const PLAN_SYSTEM_PROMPT = [
  "You fill out US job-application forms for a real candidate, the way a careful human assistant would.",
  "You get every empty field on the current page: widget kind, label, section, whether it is required, and for choice widgets the EXACT options.",
  "page.formText is a compact excerpt of visible labels, placeholders and question copy on the step — use it to understand wording the field label alone may miss. page.buttons lists Apply/Next/Submit controls for context only; do not return button clicks.",
  'Return ONLY JSON: {"answers":[{"id":"","value":"","values":[],"skip":false,"source":"","confidence":0}]} with one object for EVERY field id.',
  "",
  "EVIDENCE — strongest first:",
  "1. candidateKnowledge: facts the candidate confirmed, learned from their Q&A bank and profile. The truth for anything personal — eligibility, sponsorship, visa, location, relocation, salary, start date, notice period, EEO, clearance, languages, education, years of experience.",
  "2. bankMatches on a field: the candidate's saved answers to similar questions on other forms. Reuse the meaning, not necessarily the words. unverified=true marks an earlier AI answer — use it only when it agrees with candidateKnowledge.",
  "3. profileHint on a field: the profile value a rule engine matched to that field.",
  "4. resumeExcerpt / resume / candidateProjects: skills, tools, employers, titles, years with a technology, achievements.",
  "5. job: only for motivation or fit questions (why this company, why this role) and to tailor essays.",
  "source: kb | qa | profile | resume | jd | default — where the answer came from (default = a reasonable standard answer with no direct evidence).",
  "confidence: 0-1, how directly the evidence supports the value.",
  "",
  "BY KIND:",
  '- select / radio / combobox: value MUST be copied character-for-character from that field\'s options. Choose by MEANING and watch negation ("I do not have a disability" vs "I have a disability"). If optionsTruncated is true and the right option is not shown, give the exact wording you expect (e.g. "United States"). If optionsAsync is true there is no list yet — give the short text to search for (e.g. a city name). multiple=true → put every option to pick in values.',
  "- checkbox_group: values = every option to tick, each copied exactly from options.",
  '- checkbox (one box): value "Yes" to tick it, "No" to leave it unticked. Tick required consent / acknowledgement / certify-accurate / terms boxes. Leave marketing, newsletter, SMS and talent-community opt-ins unticked unless the candidate opted in.',
  "- text: the value only — no sentence unless the label asks an open question. inputType number → digits only. inputType date → YYYY-MM-DD; otherwise follow the placeholder format (e.g. MM/DD/YYYY). Respect maxLength.",
  '- textarea / richtext: follow answerShape. "short" → one direct sentence within maxWords. "long" → 2-4 short first-person paragraphs (90-180 words) grounded in the resume and candidateProjects. If mustBeAbout is set, the answer must be about exactly those terms; with no evidence say so briefly, or answer exactly "N/A" when naAllowed is true.',
  "",
  "RULES:",
  "- Keep answers consistent with each other across the whole form, and with alreadyFilled.",
  "- Required field with no evidence: give the most reasonable truthful answer. For EEO / voluntary self-identification with no knowledge, pick the decline / prefer-not-to-say option.",
  "- Optional field with no evidence (a referring employee's name, middle name, second address line, and the like): skip=true.",
  '- "How did you hear about us": use candidateKnowledge when it says; otherwise an online / job-board option such as LinkedIn, Job board, or Company website. Never invent a referrer\'s name.',
  "- Never invent employers, degrees, certifications, clearances, visas, licenses, or references. Never put Yes/No into a field that is not a yes/no question.",
  "- Plain text only, no markdown."
].join("\n");

function buildContext({
  knowledgeBase,
  applicantInfo,
  jobMeta,
  resumeText,
  applicationBrief,
  alreadyFilled,
  page,
  buttons = []
}) {
  const brief = applicationBrief && typeof applicationBrief === "object" ? applicationBrief : null;
  const job = {
    title: jobMeta.jobTitle || brief?.jobTitle || "",
    company: jobMeta.companyName || brief?.companyName || ""
  };
  const jd = String(jobMeta.jdText || "").trim();
  if (jd) job.descriptionExcerpt = jd.slice(0, 3500);

  const ctx = {
    job,
    candidateKnowledge: renderKbForPrompt(knowledgeBase) || { facts: [] },
    candidateProfile: compactApplicantContext(applicantInfo)
  };
  if (brief) {
    ctx.resume = {
      roleSummary: brief.roleSummary || "",
      topSkills: brief.topSkills || [],
      keyExperiences: brief.keyExperiences || []
    };
  }
  // Even with a brief, the raw resume settles "years with X" and employer questions.
  const resume = String(resumeText || "").trim();
  if (resume) ctx.resumeExcerpt = resume.slice(0, brief ? 2500 : 4500);

  const projects = selectRelevantProjects(applicantInfo?.projectManifest, {
    jdText: jd,
    jobTitle: job.title,
    limit: 5,
    maxChars: 2500
  });
  if (projects.length) ctx.candidateProjects = buildProjectAnswerContext(projects);
  if (Array.isArray(alreadyFilled) && alreadyFilled.length) {
    ctx.alreadyFilled = alreadyFilled.slice(0, 30);
  }
  if (page) {
    const pageButtons =
      Array.isArray(buttons) && buttons.length
        ? buttons
        : Array.isArray(page.buttons)
          ? page.buttons
          : [];
    ctx.page = {
      title: page.title || "",
      ...(Array.isArray(page.headings) && page.headings.length ? { headings: page.headings } : null),
      ...(page.step ? { step: page.step } : null),
      ...(page.formText ? { formText: String(page.formText).slice(0, 3500) } : null),
      ...(pageButtons.length
        ? {
            buttons: pageButtons.slice(0, 40).map((b) => ({
              text: String(b.text || "").slice(0, 80),
              ...(b.hint ? { hint: b.hint } : null),
              ...(b.inForm ? { inForm: true } : null)
            }))
          }
        : null)
    };
  }
  return ctx;
}

function readAnswers(content, chunk) {
  const obj = parseJsonReply(content);
  const rows = Array.isArray(obj?.answers) ? obj.answers : [];
  const ids = new Set(chunk.map((f) => f.id));
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    let value = row?.value;
    let values = row?.values;
    if (Array.isArray(value)) {
      values = value;
      value = "";
    }
    value = value == null ? "" : String(value).trim();
    values = Array.isArray(values) ? values.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
    const source = String(row?.source || "").toLowerCase();
    out.push({
      id,
      value,
      values,
      skip: row?.skip === true,
      source: ANSWER_SOURCES.has(source) ? source : "default",
      confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0))
    });
  }
  return out;
}

function clipToLength(text, maxLength) {
  const limit = Number(maxLength) || 0;
  if (!limit || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return sentenceEnd > limit * 0.6 ? cut.slice(0, sentenceEnd + 1) : cut.trimEnd();
}

/**
 * Check one reply against its field.
 * @returns {{ ok: true, answer: object } | { ok: false, issue?: string }}
 */
function validateAnswer(field, row) {
  const base = { id: field.id, kind: field.kind, source: row.source, confidence: row.confidence };
  const options = Array.isArray(field.options) ? field.options : [];

  if (field.kind === "select" || field.kind === "radio" || field.kind === "combobox") {
    const wanted = field.multiple
      ? row.values.length
        ? row.values
        : [row.value]
      : [row.value || row.values[0] || ""];
    if (!options.length) {
      // Async search box, or a list the scan could not read: the text goes
      // through the widget's own suggestions.
      const text = wanted.find(Boolean) || "";
      return text ? { ok: true, answer: { ...base, value: text.slice(0, 120), values: [] } } : { ok: false };
    }
    const matched = [...new Set(wanted.map((v) => matchOption(v, options)).filter(Boolean))];
    if (!matched.length) {
      // A searchable list may have shown only its first page of options. Hand the
      // text to the widget's own filter — it still commits only a real option.
      const text = field.kind === "combobox" ? wanted.find(Boolean) || "" : "";
      return text
        ? { ok: true, answer: { ...base, value: text.slice(0, 120), values: [] } }
        : { ok: false };
    }
    return {
      ok: true,
      answer: { ...base, value: matched[0], values: field.multiple ? matched : [] }
    };
  }

  if (field.kind === "checkbox_group") {
    const wanted = row.values.length ? row.values : row.value ? [row.value] : [];
    const matched = [...new Set(wanted.map((v) => matchOption(v, options)).filter(Boolean))];
    if (!matched.length) return { ok: false };
    return { ok: true, answer: { ...base, value: matched[0], values: matched } };
  }

  if (field.kind === "checkbox") {
    const tick =
      leadYesNo(normalizeText(row.value)) === "yes" ||
      /^(true|checked|check|tick|agree|i agree|accept)$/i.test(row.value);
    // Leaving a box unticked needs no action on the page.
    if (!tick) return { ok: false };
    return { ok: true, answer: { ...base, value: "Yes", values: [] } };
  }

  const text = row.value.trim();
  if (!text) return { ok: false };

  if (LONG_KINDS.has(field.kind)) {
    const issue = answerResponsivenessIssue(
      { label: field.label, multiline: true, richText: field.kind === "richtext", fieldType: field.kind },
      text
    );
    if (issue) return { ok: false, issue };
    return { ok: true, answer: { ...base, value: clipToLength(text, field.maxLength), values: [] } };
  }

  let value = text;
  if (field.inputType === "number") {
    const m = value.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (!m) return { ok: false };
    value = m[0];
  }
  if (/^(yes|no)\.?$/i.test(value) && NOT_YES_NO_LABEL_RE.test(normalizeText(field.label))) {
    return { ok: false };
  }
  return { ok: true, answer: { ...base, value: clipToLength(value, field.maxLength), values: [] } };
}

/**
 * Answer every scanned field on one application step.
 *
 * @param {object} args
 * @param {Array<object>} args.fields scanned fields ({ id, kind, label, section, required, options, ... })
 * @param {Map<string, Array<{ record: object, score: number }>>} args.bankMatches per-field Q&A bank matches
 * @returns {Promise<{ answers: Array<{ id: string, kind: string, value: string, values: string[], source: string, confidence: number }>, skipped: string[], unanswered: string[], usage: object | null, calls: number }>}
 */
export async function planFormAnswers({
  apiKey,
  model,
  fields = [],
  knowledgeBase = null,
  applicantInfo = {},
  jobMeta = {},
  resumeText = "",
  applicationBrief = null,
  bankMatches = new Map(),
  alreadyFilled = [],
  page = null,
  buttons = []
}) {
  const list = (fields || []).filter((f) => f?.id && f?.label && FIELD_KINDS.has(f.kind));
  const empty = { answers: [], skipped: [], unanswered: [], usage: null, calls: 0 };
  if (!list.length) return empty;

  const context = buildContext({
    knowledgeBase,
    applicantInfo,
    jobMeta,
    resumeText,
    applicationBrief,
    alreadyFilled,
    page,
    buttons
  });
  const hintPool = makeHintPool(knowledgeBase, applicantInfo);
  const byId = new Map(list.map((f) => [f.id, f]));

  // Essays get their own small calls so a long answer never crowds out the rest.
  const long = list.filter((f) => LONG_KINDS.has(f.kind) && shapeFor(f).shape === "long");
  const longIds = new Set(long.map((f) => f.id));
  const rest = list.filter((f) => !longIds.has(f.id));
  const chunks = [];
  for (let i = 0; i < rest.length; i += SHORT_CHUNK) chunks.push(rest.slice(i, i + SHORT_CHUNK));
  for (let i = 0; i < long.length; i += LONG_CHUNK) chunks.push(long.slice(i, i + LONG_CHUNK));

  let usage = null;
  let calls = 0;
  const addUsage = (next) => {
    if (!next) return;
    usage = usage
      ? {
          prompt_tokens: Number(usage.prompt_tokens || 0) + Number(next.prompt_tokens || 0),
          completion_tokens:
            Number(usage.completion_tokens || 0) + Number(next.completion_tokens || 0),
          total_tokens: Number(usage.total_tokens || 0) + Number(next.total_tokens || 0)
        }
      : { ...next };
  };

  const ask = async (chunk, correction = "") => {
    const hasLong = chunk.some((f) => longIds.has(f.id));
    const messages = [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          ...context,
          fields: chunk.map((f) => describeField(f, { bankMatches, hintPool }))
        })
      }
    ];
    if (correction) messages.push({ role: "user", content: correction });
    const result = await chatCompletion({
      apiKey,
      model,
      jsonMode: true,
      temperature: hasLong ? 0.5 : 0.15,
      maxTokens: hasLong ? 4000 : 3000,
      messages
    });
    calls += 1;
    addUsage(result.usage);
    return readAnswers(result.content, chunk);
  };

  const answers = [];
  const skipped = [];
  const unanswered = [];

  const runChunk = async (chunk) => {
    const rows = await ask(chunk);
    const rejects = [];
    for (const row of rows) {
      const field = byId.get(row.id);
      if (row.skip) {
        skipped.push(row.id);
        continue;
      }
      const checked = validateAnswer(field, row);
      if (checked.ok) answers.push(checked.answer);
      else if (checked.issue) rejects.push({ field, issue: checked.issue });
    }
    if (!rejects.length) return;

    // Re-ask only for essays that do not answer their own question.
    const correction =
      "Your answers to these ids were rejected. Rewrite ONLY these, answering the actual question this time:\n" +
      rejects
        .map(({ field, issue }) => `- id ${field.id} (question: ${field.label.slice(0, 200)}) — ${issue}.`)
        .join("\n");
    let retried = [];
    try {
      retried = await ask(
        rejects.map((r) => r.field),
        correction
      );
    } catch {
      retried = [];
    }
    const retriedById = new Map(retried.map((r) => [r.id, r]));
    for (const { field } of rejects) {
      const again = retriedById.get(field.id);
      const checked = again && !again.skip ? validateAnswer(field, again) : { ok: false };
      if (checked.ok) {
        answers.push(checked.answer);
      } else if (shapeFor(field).allowsNa) {
        // The form's own escape hatch beats an off-topic essay.
        answers.push({ id: field.id, kind: field.kind, value: "N/A", values: [], source: "default", confidence: 0.3 });
      }
    }
  };

  let firstError = null;
  for (let i = 0; i < chunks.length; i += MAX_PARALLEL_CALLS) {
    const batch = chunks.slice(i, i + MAX_PARALLEL_CALLS);
    const settled = await Promise.allSettled(batch.map(runChunk));
    settled.forEach((outcome, j) => {
      if (outcome.status === "fulfilled") return;
      firstError = firstError || outcome.reason;
      for (const f of batch[j]) unanswered.push(f.id);
    });
  }
  if (firstError && unanswered.length === list.length) throw firstError;

  return { answers, skipped, unanswered, usage, calls };
}

const BUTTON_SYSTEM_PROMPT = [
  "You read the clickable buttons and links on a job website and pick the ONE that moves a job application forward.",
  'Return ONLY JSON: {"id":"<button id or null>","type":"entry|next|review|submit|none","reason":""}.',
  'stage "entry": we are on a job posting and must open the application — Apply, Apply now, Easy Apply, I\'m interested, Start application, Apply for this job, Apply manually.',
  'stage "next": we are inside the application and this step is filled — pick what saves the step and continues: Next, Continue, Save and continue, Review.',
  'Use type "submit" only for a button that sends the finished application.',
  'Never pick: sign in / log in / create account / forgot password, social or profile import (LinkedIn, Indeed, Google, "autofill with resume"), cookie or consent banners, share, save job, job alerts, back, cancel, close, menus, other job postings, or chat widgets.',
  'Never pick marketing or company pages: Explore, About us, Corporate Governance / Corporate Profile, Careers home, Contact us, Get in touch, Talk with an expert, Investors, Privacy, Terms, Sustainability, Media, News, Press.',
  "If a button's href looks like about-us, corporate-profile, investors, privacy, or similar, return id null.",
  "Prefer applying manually over importing a profile. If nothing fits, return id null and type none."
].join("\n");

/**
 * Pick the button that starts or continues the application when the rule-based
 * finder recognises none of the page's buttons.
 * @returns {Promise<{ id: string | null, type: string, reason: string, usage: object | null }>}
 */
export async function pickApplicationButton({
  apiKey,
  model,
  buttons = [],
  page = null,
  stage = "entry",
  job = {}
}) {
  const list = (buttons || []).filter((b) => b?.id && b?.text).slice(0, 40);
  if (!list.length) return { id: null, type: "none", reason: "no buttons", usage: null };

  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0,
    maxTokens: 300,
    messages: [
      { role: "system", content: BUTTON_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          stage,
          job: { title: job.jobTitle || "", company: job.companyName || "" },
          page: page ? { url: page.url || "", title: page.title || "", headings: page.headings || [] } : null,
          buttons: list.map((b) => ({
            id: b.id,
            text: b.text,
            ...(b.hint ? { looksLike: b.hint } : null),
            ...(b.inForm ? { inForm: true } : null),
            ...(b.inDialog ? { inDialog: true } : null),
            ...(b.href ? { href: b.href } : null)
          }))
        })
      }
    ]
  });

  const obj = parseJsonReply(result.content) || {};
  const id = String(obj.id || "").trim();
  const hit = list.find((b) => b.id === id) || null;
  const type = String(obj.type || "").toLowerCase();
  return {
    id: hit ? hit.id : null,
    type: hit && ["entry", "next", "review", "submit"].includes(type) ? type : hit ? stage : "none",
    reason: String(obj.reason || "").slice(0, 200),
    usage: result.usage || null
  };
}
