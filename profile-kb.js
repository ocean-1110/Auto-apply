/**
 * Per-profile knowledge base for application forms.
 *
 * The Q&A bank stores answers exactly as they were typed on some past form,
 * under that form's wording. A new form rarely repeats the wording, so text
 * matching alone misses most of what the candidate already told us. The
 * knowledge base is the form model's distilled reading of the whole bank plus
 * the profile: one canonical fact per topic, conflicts resolved, rewordings
 * merged — so the form planner can answer any phrasing of the same question.
 *
 * Only what the candidate actually said feeds it: profile fields, their notes,
 * and Q&A answers they typed, edited or imported. Answers the AI cached into the
 * bank are left out, so the model never learns its own guesses as facts.
 *
 * Stored per profile in chrome.storage.local and rebuilt whenever a hash of its
 * sources changes. Used only from the background service worker.
 */

import { chatCompletion, parseJsonReply } from "./openai.js";
import { getQaForProfileAndShared, normalizeQuestion } from "./qa-store.js";
import { getApplicantInfo, APPLICANT_VALUE_LABELS, US_STATES } from "./applicant-info.js";

const KB_KEY = "profile_kb_by_profile";
/** Bumped on every store so open pages (the Q&A editor) can re-render. */
export const KB_VERSION_KEY = "profile_kb_version";
const KB_SCHEMA = 1;
const MAX_QA_ROWS = 220;
const MAX_FACTS = 120;
const MAX_RULES = 12;
const CANDIDATE_NOTES_CHARS = 3000;

/**
 * Readable prompts for the profile fields the knowledge base learns from, so
 * the model reads a question instead of a storage key. Names, email, phone and
 * street address are left out: identity autofill owns them, and they carry no
 * answer to a screening question.
 */
const PROFILE_FIELD_LABELS = {
  country: "Country",
  city: "City",
  state: "State",
  zipCode: "ZIP code",
  cityCountryOfResidence: "City and country of residence",
  workAuthorized: "Legally authorized to work in the United States",
  needsSponsorship: "Needs visa sponsorship now or in the future",
  postEmploymentRestrictions: "Bound by a non-compete or other post-employment restriction",
  willingToRelocate: "Willing to relocate",
  over18: "At least 18 years old",
  felonyConviction: "Has a felony or criminal conviction",
  felonyExplanation: "Conviction explanation",
  yearsExperience: "Total years of professional experience",
  relevantExperience: "Relevant experience",
  englishLevel: "English level",
  linkedinUrl: "LinkedIn URL",
  portfolioUrl: "Portfolio or personal website URL",
  githubUrl: "GitHub URL",
  highestDegree: "Highest degree",
  schoolName: "School",
  fieldOfStudy: "Field of study",
  graduationDate: "Graduation date",
  whyInterested: "Standard answer to 'why are you interested'",
  salaryExpectation: "Salary expectation",
  earliestStartDate: "Earliest start date / availability",
  backgroundCheckConsent: "Consents to a background check",
  drugTestConsent: "Consents to a drug test",
  gender: "Gender (EEO, voluntary)",
  hispanicLatino: "Hispanic or Latino (EEO, voluntary)",
  raceEthnicity: "Race / ethnicity (EEO, voluntary)",
  veteranStatus: "Veteran status (EEO, voluntary)",
  disabilityStatus: "Disability status (EEO, voluntary)"
};

const KB_TOPICS = [
  "work_authorization",
  "sponsorship",
  "visa_status",
  "citizenship",
  "security_clearance",
  "location",
  "relocation",
  "remote_preference",
  "commute",
  "travel",
  "start_date",
  "notice_period",
  "employment_status",
  "salary",
  "hourly_rate",
  "years_experience",
  "skill_experience",
  "education",
  "certifications",
  "languages",
  "previous_employer",
  "relatives_at_company",
  "government_employment",
  "non_compete",
  "age_over_18",
  "background_check",
  "drug_test",
  "criminal_record",
  "referral_source",
  "eeo_gender",
  "eeo_race",
  "eeo_hispanic",
  "eeo_veteran",
  "eeo_disability",
  "pronouns",
  "links",
  "consent",
  "motivation",
  "other"
];

const KB_SYSTEM_PROMPT = [
  "You maintain a knowledge base about ONE job candidate. It is used later to answer US job-application forms on any website, whatever wording those forms use.",
  "Input: profile (fields the candidate filled in), candidateNotes (background the candidate wrote, optional), qaBank (answers the candidate gave to real application questions, newest first).",
  'Return ONLY JSON: {"summary":"","facts":[{"topic":"","question":"","answer":"","detail":""}],"rules":[]}',
  "",
  "facts:",
  "- One fact per distinct topic or question. Merge duplicates and rewordings of the same question into one canonical question.",
  '- answer: the candidate\'s position in its shortest reusable form, e.g. "Yes", "No", "$120,000", "2 weeks", "US Citizen", "Bachelor\'s in Computer Science".',
  '- detail: only the nuance needed to answer variants of the question (e.g. "Green card holder; will not need sponsorship now or in the future"). Empty when there is none.',
  '- Conflicts: a newer qaBank answer beats an older one; scope "profile" beats "shared"; an explicit profile field beats the bank unless a newer bank answer clearly updates it.',
  '- Derive only what the input directly implies ("US citizen" implies authorized to work in the US = Yes and sponsorship = No). Never guess anything else — no invented employers, skills, dates, numbers, clearances, or visas.',
  '- Record experience with specific skills or technologies (topic skill_experience) when the bank or notes state it, e.g. "Years of experience with Salesforce" → "8".',
  "- Keep EEO answers exactly as the candidate gave them; they are voluntary self-identification.",
  "- Leave out email, phone, and street address.",
  `- topic: snake_case, from this list when one fits: ${KB_TOPICS.join(", ")}.`,
  "",
  'rules: up to 12 short if/then policies the answers imply, e.g. "Relocation: yes, but only within Texas" or "Decline to self-identify on every EEO question". Empty array when there are none.',
  "summary: 2-3 sentences — location, work authorization, seniority and specialty. No contact details."
].join("\n");

function readableProfileValue(key, raw) {
  const labels = APPLICANT_VALUE_LABELS[key];
  if (labels && Array.isArray(labels[raw]) && labels[raw].length) return labels[raw][0];
  if (key === "state") {
    return US_STATES.find((s) => s.value && s.value === raw.toUpperCase())?.label || raw;
  }
  if (/^(yes|no)$/i.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return raw;
}

/** FNV-1a — only has to notice that the sources changed, not resist tampering. */
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Everything the knowledge base is learned from, plus a hash of it.
 * @returns {Promise<{ profileId: string, profile: Array<{ key: string, label: string, value: string }>, candidateNotes: string, qaRows: Array<object>, hash: string }>}
 */
export async function collectKbSources(profileId) {
  const applicantInfo = await getApplicantInfo(profileId);
  const profile = [];
  for (const [key, label] of Object.entries(PROFILE_FIELD_LABELS)) {
    const raw = String(applicantInfo?.[key] ?? "").trim();
    if (!raw) continue;
    profile.push({ key, label, value: readableProfileValue(key, raw).slice(0, 600) });
  }
  const candidateNotes = String(applicantInfo?.candidateInfo || "")
    .trim()
    .slice(0, CANDIDATE_NOTES_CHARS);

  const rows = await getQaForProfileAndShared(profileId).catch(() => []);
  const qaRows = rows
    .filter((r) => r?.question && r?.answer && String(r.source || "user") !== "ai")
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, MAX_QA_ROWS)
    .map((r) => ({
      question: String(r.question).trim().slice(0, 300),
      answer: String(r.answer).trim().slice(0, 400),
      fieldType: r.fieldType || "text",
      scope: r.profileId ? "profile" : "shared",
      updatedAt: Number(r.updatedAt || 0)
    }));

  // Order-independent: re-saving an unchanged answer must not look like news.
  const hash = hashText(
    JSON.stringify({
      schema: KB_SCHEMA,
      profile: profile.map((p) => [p.key, p.value]),
      notes: candidateNotes,
      qa: qaRows.map((r) => `${r.scope}|${normalizeQuestion(r.question)}|${r.answer}`).sort()
    })
  );
  return { profileId, profile, candidateNotes, qaRows, hash };
}

async function readKbMap() {
  const data = await chrome.storage.local.get(KB_KEY);
  const map = data[KB_KEY];
  return map && typeof map === "object" ? map : {};
}

export async function getStoredKb(profileId) {
  if (!profileId) return null;
  const map = await readKbMap();
  const kb = map[profileId];
  return kb && typeof kb === "object" ? kb : null;
}

async function storeKb(profileId, kb) {
  const map = await readKbMap();
  map[profileId] = kb;
  await chrome.storage.local.set({ [KB_KEY]: map, [KB_VERSION_KEY]: Date.now() });
}

function hasAnySource(sources) {
  return Boolean(sources.profile.length || sources.qaRows.length || sources.candidateNotes);
}

/**
 * The stored knowledge base and whether it needs re-learning: its sources moved
 * on since it was built, or it was only a raw fallback and the model can now
 * do better.
 */
export async function getKbStatus(profileId) {
  const [kb, sources] = await Promise.all([getStoredKb(profileId), collectKbSources(profileId)]);
  const stale =
    !kb ||
    kb.schema !== KB_SCHEMA ||
    kb.sourceHash !== sources.hash ||
    (!kb.learned && hasAnySource(sources));
  return { kb, sources, stale };
}

function finishKb(sources, { summary = "", facts = [], rules = [], learned = false, model = "" }) {
  return {
    schema: KB_SCHEMA,
    profileId: sources.profileId,
    summary: String(summary || "").trim().slice(0, 600),
    facts: facts.slice(0, MAX_FACTS),
    rules: rules.slice(0, MAX_RULES),
    learned,
    model: model || "",
    sourceHash: sources.hash,
    qaCount: sources.qaRows.length,
    profileFieldCount: sources.profile.length,
    builtAt: Date.now()
  };
}

/** A knowledge base without the model: the raw facts, newest answer per question. */
export function buildFallbackKb(sources) {
  const facts = sources.profile.map((p) => ({
    topic: p.key,
    question: p.label,
    answer: p.value,
    detail: ""
  }));
  const seen = new Set();
  for (const row of sources.qaRows) {
    const norm = normalizeQuestion(row.question);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    facts.push({ topic: "qa", question: row.question, answer: row.answer, detail: "" });
  }
  return finishKb(sources, { facts, learned: false });
}

function cleanFact(raw) {
  const question = String(raw?.question || "").trim().slice(0, 240);
  const answer = String(raw?.answer || "").trim().slice(0, 400);
  if (!question || !answer) return null;
  const topic =
    String(raw?.topic || "other")
      .toLowerCase()
      .replace(/[^a-z0-9_:]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "other";
  const detail = String(raw?.detail || "").trim().slice(0, 300);
  return { topic, question, answer, detail };
}

async function learnKb({ apiKey, model, sources }) {
  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 6000,
    messages: [
      { role: "system", content: KB_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          profile: sources.profile.map((p) => ({ field: p.label, value: p.value })),
          ...(sources.candidateNotes ? { candidateNotes: sources.candidateNotes } : null),
          qaBank: sources.qaRows.map((r) => ({
            q: r.question,
            a: r.answer,
            type: r.fieldType,
            scope: r.scope,
            saved: r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 10) : ""
          }))
        })
      }
    ]
  });

  const obj = parseJsonReply(result.content);
  if (!obj || !Array.isArray(obj.facts)) {
    throw new Error("Knowledge base reply was not valid JSON.");
  }
  const facts = obj.facts.map(cleanFact).filter(Boolean);
  if (!facts.length) throw new Error("Knowledge base came back empty.");
  const rules = (Array.isArray(obj.rules) ? obj.rules : [])
    .map((r) => String(r || "").trim().slice(0, 240))
    .filter(Boolean);
  return {
    kb: finishKb(sources, { summary: obj.summary, facts, rules, learned: true, model }),
    usage: result.usage || null
  };
}

const inflight = new Map();

/**
 * Re-learn one profile's knowledge base. Concurrent callers share one run, so a
 * background refresh and an Apply that both notice the change pay for it once.
 * When the model is unavailable the raw facts are stored instead, marked
 * `learned: false`, so the next run tries the model again.
 * @returns {Promise<{ kb: object | null, usage: object | null, error?: string }>}
 */
export function rebuildProfileKb({ profileId, apiKey, model, sources = null }) {
  if (!profileId) return Promise.resolve({ kb: null, usage: null });
  const running = inflight.get(profileId);
  if (running) return running;

  const run = (async () => {
    const src = sources || (await collectKbSources(profileId));
    if (!hasAnySource(src)) {
      const kb = finishKb(src, { learned: true });
      await storeKb(profileId, kb);
      return { kb, usage: null };
    }
    try {
      const { kb, usage } = await learnKb({ apiKey, model, sources: src });
      await storeKb(profileId, kb);
      return { kb, usage };
    } catch (err) {
      const message = String(err?.message || err);
      if (/cancelled by user/i.test(message)) throw err;
      const kb = buildFallbackKb(src);
      await storeKb(profileId, kb);
      return { kb, usage: null, error: message };
    }
  })().finally(() => inflight.delete(profileId));

  inflight.set(profileId, run);
  return run;
}

/**
 * The knowledge base as prompt context. One line per fact keeps ~120 facts
 * cheap enough to send with every form-plan call.
 * @returns {{ summary?: string, facts: string[], rules?: string[] } | null}
 */
export function renderKbForPrompt(kb, { maxFacts = MAX_FACTS } = {}) {
  if (!kb || !Array.isArray(kb.facts) || !kb.facts.length) return null;
  const facts = kb.facts.slice(0, maxFacts).map((f) => {
    const detail = f.detail ? ` (${f.detail})` : "";
    return `[${f.topic}] ${f.question} → ${f.answer}${detail}`;
  });
  return {
    ...(kb.summary ? { summary: kb.summary } : null),
    facts,
    ...(Array.isArray(kb.rules) && kb.rules.length ? { rules: kb.rules } : null)
  };
}
