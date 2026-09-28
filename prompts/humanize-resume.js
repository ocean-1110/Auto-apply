/**
 * Strong humanize appendix for resume generation.
 * Applied on Greenhouse, Ashby, and Lever, which screen AI-sounding resumes.
 */

import { applySiteFromUrl } from "../ats/adapters.js";

export const STRONG_HUMANIZE_MODE_KEY = "strong_humanize_mode";

export const STRONG_HUMANIZE_MODES = Object.freeze({
  OFF: "off",
  AUTO: "auto",
  ON: "on"
});

export const ANTI_AI_RESUME_SITES = new Set(["greenhouse", "ashby", "lever"]);

const HUMANIZE_RULES = `Rewrite the resume prose so it reads like it was written by a real engineer with real experience, not AI. AI detectors flag symmetrical, polished wording.

Follow these rules:
Vary sentence rhythm and structure.
Use occasional informal phrasing that still fits a professional resume.
Add realistic micro-stories or context (short, subtle, not long paragraphs).
Use verbs that humans naturally use instead of AI-favored verbs.
Add specific details about tools, systems, and challenges.
Include realistic numbers, metrics, and outcomes already supported by the candidate information.
Avoid generic corporate cliches and buzzwords.
Avoid symmetrical or overly polished sentences.
Avoid repeating the same verbs at the start of bullets.
Keep the resume ATS-friendly with clear bullets and exact product names.`;

export const US_RESUME_STYLE_RULES = `US RESUME STYLE (required for this run):
- Write in standard US senior resume voice: reverse-chronological experience, crisp bullets, City/ST location style.
- Prefer concrete US workplace phrasing over generic global corporate speak.
- Keep bullets scannable for US ATS parsers (Greenhouse / Ashby / Lever friendly).
- No photo, no objective essay, no "References available upon request".
- Do not add clearance, citizenship, visa, or immigration language — including in the headline.`;

export function normalizeStrongHumanizeMode(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "never") {
    return STRONG_HUMANIZE_MODES.OFF;
  }
  if (v === "on" || v === "always" || v === "true" || v === "1" || v === "strong") {
    return STRONG_HUMANIZE_MODES.ON;
  }
  return STRONG_HUMANIZE_MODES.AUTO;
}

export function isAntiAiResumeSite(siteOrUrl = "") {
  const raw = String(siteOrUrl || "").trim().toLowerCase();
  if (!raw) return false;
  if (ANTI_AI_RESUME_SITES.has(raw)) return true;
  const site = applySiteFromUrl(raw.includes("://") ? raw : `https://${raw}`);
  return ANTI_AI_RESUME_SITES.has(site);
}

export function shouldApplyStrongHumanize(mode, ctx = {}) {
  const m = normalizeStrongHumanizeMode(mode);
  if (m === STRONG_HUMANIZE_MODES.OFF) return false;
  if (m === STRONG_HUMANIZE_MODES.ON) return true;
  return isAntiAiResumeSite(ctx.site || ctx.jdLink || "");
}

export function buildStrongHumanizeAppendix() {
  return `
==================================================
STRONG HUMANIZE + US RESUME VOICE (ANTI-AI / FAKER DETECTORS)
==================================================
This job board screens for AI-generated resumes. Apply the rules below to prose inside the JSON only: profile, experience bullets, projects, and technicalSummary sentences.

Do NOT humanize away exact skill spellings — skills items must keep JD/product spellings (for example "Lightning Web Components", "Service Cloud", "Snowflake", "React").
Never add clearance, citizenship, visa, or immigration language — including in the headline.
Never paste the JD job title verbatim into the headline.
Vary the prose, but do not replace a JD tool or product with a synonym.

${US_RESUME_STYLE_RULES}

${HUMANIZE_RULES}

CRITICAL OUTPUT CONSTRAINT
Still return ONLY one complete valid resume JSON object matching the schema from the main prompt.
Humanize the wording inside the JSON fields — do not add Markdown, commentary, or detector notes before or after the JSON.
Do not invent employers, titles, dates, degrees, certifications, clearances, or contact details.
`.trim();
}

export async function getStrongHumanizeMode() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return STRONG_HUMANIZE_MODES.AUTO;
  }
  const data = await chrome.storage.local.get(STRONG_HUMANIZE_MODE_KEY);
  return normalizeStrongHumanizeMode(data[STRONG_HUMANIZE_MODE_KEY]);
}
