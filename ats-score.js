/**
 * GPT ATS score for a generated resume vs JD.
 * The model evaluates keyword/relevance coverage; this module only
 * normalizes the JSON and maps it into the popup display band.
 *
 * Displayed overall scores are kept in a realistic band (up to 90%).
 * Rewrite pipeline targets at least 80%.
 */

import { chatCompletion, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { logLlmCall } from "./cost-tracker.js";

export const ATS_SCORE_DISPLAY_MAX = 90;
export const ATS_SCORE_TARGET_MIN = 80;

const ATS_SCORE_SYSTEM = `You are a US Applicant Tracking System (ATS) evaluator for technical / Salesforce roles.

Score how well the resume would pass an automated ATS keyword and relevance screen against the job description. You are the only scorer — do not assume any local keyword list.

Rules:
- Ignore benefits, EEO, salary, sponsorship, culture, and company marketing copy.
- Score named products, clouds, managed packages, tools, required skills, title alignment, and years of relevant experience.
- Treat common aliases as matches (FSC = Financial Services Cloud, LWC = Lightning Web Components, SF DX / SFDX = Salesforce DX, Flows = Flow Builder when Flows are clearly present).
- Do not require the hiring company name to appear on the resume.
- Do not penalize paraphrased duties when the exact product/tool names are present in skills or experience.
- missing: real JD products/tools/skills that are absent from the resume. Never include generic phrases, locations, benefits language, or the employer name.
- criticalMissing: must-have named products/tools still missing (for example nCino, FSC, Copado, a required cloud). Empty if none.
- plantableMissing: missing product/tool names that can be added to the skills section. Exclude certifications the resume does not already list.

Scoring calibration (IMPORTANT — use the full range; do NOT default to 85):
- Weak / few JD keywords: 35–55
- Partial match: 56–74
- Solid match with some gaps: 75–82
- Strong match with most named products present: 83–90
- Near-complete match: 88–92 (still not 100)
- Pick an integer that reflects THIS resume vs THIS JD. Avoid rounding every good resume to 85.

Return ONLY JSON with this shape:
{
  "score": 0,
  "titleMatch": 0,
  "skillsCoverage": 0,
  "keywordCoverage": 0,
  "experienceAlignment": 0,
  "matchedCount": 0,
  "totalKeywords": 0,
  "strongMatches": ["..."],
  "missing": ["..."],
  "criticalMissing": ["..."],
  "plantableMissing": ["..."],
  "rationale": "one short sentence naming the main gap or strength"
}`;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function uniqueStrings(list, max = 10) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(item || "").trim();
    if (!key) continue;
    const seenKey = key.toLowerCase();
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

function pctField(value, fallback = 0) {
  return clamp(Math.round(Number(value) || fallback), 0, 100);
}

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

function compactResumeForAts(resumeData = {}) {
  return {
    headline: resumeData?.headline || "",
    profile: String(resumeData?.profile || "").slice(0, 1200),
    skills: Array.isArray(resumeData?.skills) ? resumeData.skills.slice(0, 10) : [],
    experience: (Array.isArray(resumeData?.experience) ? resumeData.experience : []).map((job) => ({
      title: job?.title || "",
      company: job?.company || "",
      project: job?.project || "",
      bullets: Array.isArray(job?.bullets) ? job.bullets : []
    })),
    education: resumeData?.education || {},
    certifications: Array.isArray(resumeData?.certifications) ? resumeData.certifications : []
  };
}

/**
 * Map a raw coverage score into the display band.
 * Never shows 91–100 (those look fake); keeps strong resumes in ~80–90.
 */
export function toDisplayAtsScore(raw) {
  const n = clamp(Math.round(Number(raw) || 0), 0, 100);
  if (n <= ATS_SCORE_DISPLAY_MAX) return n;
  return clamp(88 + Math.round((n - 90) * 0.2), 88, ATS_SCORE_DISPLAY_MAX);
}

function normalizeAtsReport(parsed, { jobTitle = "" } = {}) {
  const rawScore = pctField(parsed?.score);
  const score = toDisplayAtsScore(rawScore);
  const missing = uniqueStrings(parsed?.missing, 8);
  const criticalMissing = uniqueStrings(parsed?.criticalMissing, 8);
  const plantableMissing = uniqueStrings(
    parsed?.plantableMissing?.length ? parsed.plantableMissing : missing.filter((t) => !/certified|certification|platform developer ii/i.test(t)),
    8
  );
  return {
    score,
    rawScore,
    finalScore: score,
    titleMatch: pctField(parsed?.titleMatch),
    skillsCoverage: pctField(parsed?.skillsCoverage),
    keywordCoverage: pctField(parsed?.keywordCoverage),
    experienceAlignment: pctField(parsed?.experienceAlignment, 70),
    matchedCount: Math.max(0, Math.round(Number(parsed?.matchedCount) || 0)),
    totalKeywords: Math.max(0, Math.round(Number(parsed?.totalKeywords) || 0)),
    strongMatches: uniqueStrings(parsed?.strongMatches, 10),
    missing,
    criticalMissing,
    plantableMissing,
    rationale: String(parsed?.rationale || "").trim().slice(0, 280),
    source: "gpt",
    jobTitle: String(jobTitle || "").trim()
  };
}

/**
 * Ask GPT to score the resume against the JD.
 *
 * @returns {Promise<{
 *   score: number,
 *   rawScore: number,
 *   finalScore: number,
 *   titleMatch: number,
 *   skillsCoverage: number,
 *   keywordCoverage: number,
 *   experienceAlignment: number,
 *   matchedCount: number,
 *   totalKeywords: number,
 *   strongMatches: string[],
 *   missing: string[],
 *   criticalMissing: string[],
 *   plantableMissing: string[],
 *   rationale: string,
 *   source: string,
 *   jobTitle: string
 * }>}
 */
export async function scoreResumeAgainstJd(
  resumeData = {},
  { jdText = "", jobTitle = "", apiKey, model = DEFAULT_OPENAI_MODEL } = {}
) {
  const result = await chatCompletion({
    apiKey,
    model: model || DEFAULT_OPENAI_MODEL,
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 900,
    messages: [
      { role: "system", content: ATS_SCORE_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          {
            jobTitle: jobTitle || "",
            jobDescription: String(jdText || "").slice(0, 8000),
            resume: compactResumeForAts(resumeData)
          },
          null,
          2
        )
      }
    ]
  });

  await logLlmCall({
    purpose: "resume-ats-score",
    model: model || DEFAULT_OPENAI_MODEL,
    inputTokens: result.usage?.prompt_tokens,
    outputTokens: result.usage?.completion_tokens
  });

  const parsed = parseJsonObject(result.content);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("GPT ATS score response was not valid JSON.");
  }
  return normalizeAtsReport(parsed, { jobTitle });
}

export function formatAtsTooltip(report) {
  if (!report) return "";
  const finalScore = Math.round(Number(report.finalScore ?? report.score) || 0);
  const lines = [`Final ATS score: ${finalScore}%`];
  if (report.source === "gpt") {
    lines.push("Scored by GPT vs the job description");
  }
  if (Number.isFinite(Number(report.rawScore)) && Number(report.rawScore) !== finalScore) {
    lines.push(`GPT raw score: ${Math.round(Number(report.rawScore))}%`);
  }
  if (report.rewritten && Number.isFinite(Number(report.previousScore))) {
    lines.push(`After rewrite (was ${Math.round(Number(report.previousScore))}%)`);
  } else if (Number.isFinite(Number(report.previousScore)) && Number(report.previousScore) !== finalScore) {
    lines.push(`Before polish: ${Math.round(Number(report.previousScore))}%`);
  }
  lines.push(
    `Title match: ${report.titleMatch}%`,
    `Skills coverage: ${report.skillsCoverage}%`,
    `Keyword coverage: ${report.keywordCoverage}% (${report.matchedCount}/${report.totalKeywords})`,
    `Experience depth: ${report.experienceAlignment}%`
  );
  if (report.strongMatches?.length) {
    lines.push(`Strong matches: ${report.strongMatches.slice(0, 6).join(", ")}`);
  }
  if (report.missing?.length) {
    lines.push(`Missing: ${report.missing.slice(0, 6).join(", ")}`);
  }
  if (report.rationale) {
    lines.push(report.rationale);
  }
  lines.push(
    `Display cap: scores above ${ATS_SCORE_DISPLAY_MAX}% are shown as ${ATS_SCORE_DISPLAY_MAX}% max`
  );
  return lines.join("\n");
}
