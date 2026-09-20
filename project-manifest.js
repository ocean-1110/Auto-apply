/**
 * Per-profile project manifest — the real projects the candidate delivered in
 * the roles already on their resume.
 *
 * The text is edited on the profile page and stored with that profile's
 * applicant info (field `projectManifest`). Resume generation, ATS rewrite,
 * preview regeneration, and application answers all pull the JD-relevant slice
 * from here, so tailored content is grounded in work that actually happened
 * instead of being invented for the posting.
 *
 * Relevance ranking is local (keyword overlap with the JD) — no extra model
 * call, so a long manifest costs nothing until its projects reach a prompt.
 */

import { getApplicantInfo } from "./applicant-info.js";

/** Projects handed to the resume model by default. */
export const DEFAULT_PROJECT_LIMIT = 8;
/** Hard cap on manifest characters placed in a prompt. */
export const DEFAULT_PROJECT_CHARS = 7000;

/** Blank line, or a `---` / `===` rule, separates one project from the next. */
const BLOCK_SPLIT_RE = /\n\s*[-=*_~]{3,}\s*\n|\n{2,}/;
const LIST_MARKER_RE = /^(?:[-*•+]|\d+[.)]|\(\d+\))\s+/;

const STOPWORDS = new Set([
  "a", "an", "as", "at", "be", "by", "do", "if", "in", "is", "it", "no", "of", "on", "or",
  "so", "to", "up", "we", "us", "the", "and", "for", "you", "your", "our", "are", "will",
  "that", "this", "these", "those", "have", "had", "has", "from", "all", "any", "can",
  "who", "how", "its", "their", "they", "them", "was", "were", "been", "being", "but",
  "out", "use", "uses", "using", "used", "work", "works", "working", "worked", "role",
  "roles", "team", "teams", "job", "jobs", "new", "other", "others", "more", "most",
  "than", "then", "when", "what", "where", "which", "while", "into", "about", "across",
  "also", "such", "per", "via", "within", "without", "over", "under", "between", "during",
  "each", "both", "some", "one", "two", "three", "many", "much", "very", "well", "good",
  "great", "strong", "ability", "able", "must", "should", "would", "could", "may",
  "might", "need", "needs", "required", "require", "requires", "requirement",
  "requirements", "preferred", "plus", "years", "year", "experience", "experiences",
  "skills", "skill", "knowledge", "understanding", "including", "include", "includes",
  "etc", "company", "companies", "business", "businesses", "customer", "customers",
  "client", "clients", "product", "products", "project", "projects", "service",
  "services", "support", "help", "ensure", "ensuring", "provide", "providing",
  "deliver", "delivering", "delivery", "drive", "driving", "lead", "leading", "partner",
  "partners", "stakeholder", "stakeholders", "opportunity", "opportunities",
  "environment", "environments", "position", "positions", "candidate", "candidates",
  "applicant", "applicants", "apply", "benefits", "salary", "compensation", "equal",
  "employer", "diversity", "inclusion", "status", "law", "laws", "policy", "policies",
  "please", "note", "responsibilities", "responsibility", "qualifications",
  "qualification", "description", "summary", "overview", "join", "looking", "seeking",
  "hiring", "full", "part", "time", "day", "days", "week", "weeks", "month", "months",
  "join", "level", "senior", "junior", "years"
]);

function tokenize(text) {
  const raw = String(text || "")
    .toLowerCase()
    .match(/[a-z][a-z0-9+#.]*|[a-z0-9]+/g);
  if (!raw) return [];
  const out = [];
  for (const item of raw) {
    const token = item.replace(/[.]+$/, "");
    if (token.length < 2) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

function bigramsOf(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function stripListMarker(line) {
  return String(line || "").replace(LIST_MARKER_RE, "").trim();
}

/**
 * Split free-form manifest text into project blocks.
 * Supports blank-line separated paragraphs, `---` rules, and one-per-line lists.
 * @returns {Array<{ index: number, title: string, text: string }>}
 */
export function parseProjectManifest(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return [];

  let blocks = raw
    .split(BLOCK_SPLIT_RE)
    .map((block) => block.trim())
    .filter(Boolean);

  // One paragraph of bullet lines: treat every line as its own project.
  if (blocks.length === 1) {
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const marked = lines.filter((line) => LIST_MARKER_RE.test(line)).length;
    if (lines.length > 1 && marked >= Math.ceil(lines.length * 0.6)) {
      blocks = lines;
    }
  }

  return blocks
    .map((block, index) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const body = lines.map(stripListMarker).filter(Boolean).join("\n");
      return {
        index,
        title: (lines[0] ? stripListMarker(lines[0]) : "").slice(0, 160),
        text: body
      };
    })
    .filter((project) => project.text);
}

/**
 * Weighted JD vocabulary used to rank projects.
 * Terms the job title mentions count for more than body terms.
 */
function buildJdProfile({ jdText = "", jobTitle = "" } = {}) {
  const titleTokens = new Set(tokenize(jobTitle));
  const jdTokens = tokenize(jdText);

  const unigramFreq = new Map();
  for (const token of jdTokens) {
    unigramFreq.set(token, (unigramFreq.get(token) || 0) + 1);
  }
  const rankedUnigrams = [...unigramFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 150);

  const weights = new Map();
  rankedUnigrams.forEach(([token], rank) => {
    weights.set(token, rank < 25 ? 2 : 1);
  });
  for (const token of titleTokens) {
    weights.set(token, Math.max(weights.get(token) || 0, 3));
  }

  const bigramFreq = new Map();
  for (const gram of bigramsOf(jdTokens)) {
    bigramFreq.set(gram, (bigramFreq.get(gram) || 0) + 1);
  }
  const bigrams = new Set(
    [...bigramFreq.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80)
      .map(([gram]) => gram)
  );
  for (const gram of bigramsOf([...titleTokens])) bigrams.add(gram);

  return { weights, bigrams, hasSignal: weights.size > 0 };
}

/** Distinct JD terms this project covers — repetition inside a project never inflates it. */
function scoreProject(project, jdProfile) {
  const tokens = tokenize(project.text);
  if (!tokens.length) return { score: 0, matched: [] };

  const seen = new Set(tokens);
  const seenBigrams = new Set(bigramsOf(tokens));
  let score = 0;
  const matched = [];

  for (const token of seen) {
    const weight = jdProfile.weights.get(token);
    if (!weight) continue;
    score += weight;
    matched.push(token);
  }
  for (const gram of seenBigrams) {
    if (jdProfile.bigrams.has(gram)) score += 3;
  }

  return { score, matched };
}

/**
 * Rank manifest projects by JD overlap and return the slice that fits a prompt.
 * With no JD signal (or no keyword overlap at all) the manifest order is kept,
 * so the model still sees real projects instead of nothing.
 *
 * @returns {Array<{ index: number, title: string, text: string, score: number }>}
 */
export function selectRelevantProjects(
  manifestText,
  { jdText = "", jobTitle = "", limit = DEFAULT_PROJECT_LIMIT, maxChars = DEFAULT_PROJECT_CHARS } = {}
) {
  const projects = parseProjectManifest(manifestText);
  if (!projects.length) return [];

  const jdProfile = buildJdProfile({ jdText, jobTitle });
  const scored = projects.map((project) => ({
    ...project,
    score: jdProfile.hasSignal ? scoreProject(project, jdProfile).score : 0
  }));

  // JD matches first, best match leading. The rest follow in manifest order:
  // a resume needs more material than one matching project can supply, and the
  // prompt already tells the model to drop what does not fit.
  const ordered = [
    ...scored.filter((project) => project.score > 0).sort((a, b) => b.score - a.score || a.index - b.index),
    ...scored.filter((project) => project.score <= 0)
  ];

  const picked = [];
  let chars = 0;
  for (const project of ordered) {
    if (picked.length >= limit) break;
    const cost = project.text.length + 8;
    // Always keep the top-ranked project, even if it alone is over budget.
    if (picked.length && chars + cost > maxChars) continue;
    picked.push(project);
    chars += cost;
  }
  return picked;
}

/**
 * Just the ranked projects, numbered, most relevant first. Use this to fill a
 * prompt template's own `{PROJECT_MANIFESTS}` slot — the template already
 * carries its own instructions, so the rules block below would fight with them.
 */
export function buildProjectManifestList(projects) {
  const list = (projects || []).filter((project) => project?.text);
  if (!list.length) return "";
  return list
    .map((project, i) => `${i + 1}. ${project.text.replace(/\n+/g, " ").trim()}`)
    .join("\n");
}

/**
 * Projects plus the rules for using them, appended to prompt templates that
 * carry no `{PROJECT_MANIFESTS}` placeholder of their own. Empty string when
 * there is nothing to add, so callers can `.filter(Boolean)` it away.
 */
export function buildProjectManifestPromptBlock(projects) {
  const lines = buildProjectManifestList(projects);
  if (!lines) return "";

  return [
    "=== CANDIDATE PROJECT MANIFEST — REAL PAST PROJECTS (HIGH PRIORITY) ===",
    "",
    "The projects below are real work this candidate delivered in the employers already listed above.",
    "They are ordered by how closely they match this job description — the first ones matter most.",
    "",
    "HOW TO USE THEM",
    "- Ground the experience bullets in these projects. Lead with the ones that align with the JD; skip the ones that add nothing for it.",
    "- Keep every project with the employer and period it belongs to. Never move a project to a different employer, and never invent an employer, date, degree, or certification.",
    "- Expand a project into the depth the JD cares about — architecture, integrations, data volumes, tooling, release process, measurable outcome — instead of restating its one-line description.",
    "- Paraphrase. Do not copy manifest wording verbatim, do not prefix a bullet with \"Project:\", and keep the required bullet counts and ~170–240 character length.",
    "- Reuse the technologies a project actually used; add adjacent JD tooling only where it is believable for that project.",
    "- Do not force every project in. A project that does not fit the JD should simply be left out.",
    "- Never name the hiring company and never hint the work was done for this posting.",
    "",
    "PROJECTS",
    lines
  ].join("\n");
}

/** Compact form for form-answer prompts, where token budget is tighter. */
export function buildProjectAnswerContext(projects, { maxChars = 500 } = {}) {
  return (projects || [])
    .filter((project) => project?.text)
    .map((project) => project.text.replace(/\s+/g, " ").trim().slice(0, maxChars));
}

/** Raw manifest text saved on a profile. */
export async function getProjectManifestText(profileId) {
  if (!profileId) return "";
  const info = await getApplicantInfo(profileId);
  return String(info?.projectManifest || "").trim();
}

/**
 * One call for the service worker: read a profile's manifest, rank it against
 * the job, and hand back both the prompt block and the picked projects.
 * `matched` counts the picks that actually overlap the JD; the remaining picks
 * are manifest-order breadth. `list` is the bare numbered projects, for a
 * template's own `{PROJECT_MANIFESTS}` slot; `block` adds the usage rules.
 * @returns {Promise<{ projects: Array, list: string, block: string, total: number, matched: number }>}
 */
export async function getProfileProjectContext(
  profileId,
  { jdText = "", jobTitle = "", limit = DEFAULT_PROJECT_LIMIT, maxChars = DEFAULT_PROJECT_CHARS } = {}
) {
  const text = await getProjectManifestText(profileId);
  if (!text) return { projects: [], list: "", block: "", total: 0, matched: 0 };

  const projects = selectRelevantProjects(text, { jdText, jobTitle, limit, maxChars });
  return {
    projects,
    list: buildProjectManifestList(projects),
    block: buildProjectManifestPromptBlock(projects),
    total: parseProjectManifest(text).length,
    matched: projects.filter((project) => project.score > 0).length
  };
}
