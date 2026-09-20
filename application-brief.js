/**
 * Compact per-job context for autofill AI. Generated once after resume JSON
 * so later form-fill calls do not re-send the full JD + resume.
 */

import { chatCompletion } from "./openai.js";
import { logLlmCall } from "./cost-tracker.js";
import { selectRelevantProjects, buildProjectAnswerContext } from "./project-manifest.js";

const BRIEF_KEY = "last_application_brief";

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

export async function getApplicationBrief() {
  const data = await chrome.storage.local.get(BRIEF_KEY);
  const brief = data[BRIEF_KEY];
  return brief && typeof brief === "object" ? brief : null;
}

export async function storeApplicationBrief(brief) {
  await chrome.storage.local.set({ [BRIEF_KEY]: brief && typeof brief === "object" ? brief : null });
}

/**
 * Build a short application brief from resume JSON + job meta.
 * Best-effort: returns null on failure so autofill can fall back to excerpts.
 */
export async function generateApplicationBrief({
  apiKey,
  model,
  resumeData = {},
  jobMeta = {},
  applicantInfo = {}
} = {}) {
  const resumeSlice = JSON.stringify({
    name: resumeData?.name,
    headline: resumeData?.headline,
    location: resumeData?.location,
    skills: resumeData?.skills,
    experience: Array.isArray(resumeData?.experience)
      ? resumeData.experience.slice(0, 4).map((j) => ({
          title: j.title,
          company: j.company,
          bullets: Array.isArray(j.bullets) ? j.bullets.slice(0, 3) : []
        }))
      : []
  });

  // Real projects from this profile's manifest, ranked against the posting, so
  // keyExperiences point at work that happened. Empty when no manifest is set.
  const candidateProjects = buildProjectAnswerContext(
    selectRelevantProjects(applicantInfo.projectManifest, {
      jdText: jobMeta.jdText || "",
      jobTitle: jobMeta.jobTitle || "",
      limit: 4,
      maxChars: 1600
    })
  );

  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content:
          "Summarize a candidate for US job-application form filling. " +
          'Return ONLY JSON: {"roleSummary":"","topSkills":[],"keyExperiences":[],"workAuth":"","location":""}. ' +
          "roleSummary: 2-3 sentences. topSkills: 8-12 strings. keyExperiences: 2-3 short bullets — " +
          "draw these from candidateProjects (real delivered work) when it is present, favouring the ones " +
          "closest to this job. " +
          "workAuth: one short phrase from the profile (sponsorship, eligibility). " +
          "Do not invent employers, visas, degrees, or projects."
      },
      {
        role: "user",
        content: JSON.stringify({
          jobTitle: jobMeta.jobTitle || "",
          companyName: jobMeta.companyName || "",
          jdExcerpt: String(jobMeta.jdText || "").slice(0, 1800),
          profile: {
            city: applicantInfo.city || "",
            state: applicantInfo.state || "",
            country: applicantInfo.country || "",
            workAuthorized: applicantInfo.workAuthorized || "",
            needsSponsorship: applicantInfo.needsSponsorship || "",
            yearsExperience: applicantInfo.yearsExperience || ""
          },
          ...(candidateProjects.length ? { candidateProjects } : null),
          resume: resumeSlice
        })
      }
    ]
  });

  await logLlmCall({
    purpose: "application_brief",
    model,
    inputTokens: result.usage?.prompt_tokens,
    outputTokens: result.usage?.completion_tokens
  });

  const obj = parseJsonObject(result.content);
  if (!obj || typeof obj !== "object") return null;

  const brief = {
    roleSummary: String(obj.roleSummary || "").trim(),
    topSkills: Array.isArray(obj.topSkills) ? obj.topSkills.map(String).slice(0, 16) : [],
    keyExperiences: Array.isArray(obj.keyExperiences)
      ? obj.keyExperiences.map(String).slice(0, 5)
      : [],
    workAuth: String(obj.workAuth || "").trim(),
    location: String(obj.location || "").trim(),
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || ""
  };
  if (!brief.roleSummary && !brief.topSkills.length) return null;
  return brief;
}
