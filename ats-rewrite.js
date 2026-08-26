/**
 * After resume JSON is generated, score it against the JD.
 * If ATS >= 80, keep that resume. If ATS < 80, rewrite until it reaches 80
 * (or max rewrite passes), then the caller renders PDF as usual.
 */

import { chatCompletion } from "./openai.js";
import { extractResumeJson } from "./resume-json.js";
import {
  scoreResumeAgainstJd,
  toDisplayAtsScore,
  ATS_SCORE_TARGET_MIN,
  ATS_SCORE_DISPLAY_MAX
} from "./ats-score.js";
import { logLlmCall } from "./cost-tracker.js";

/** Rewrite when below this display score (must reach 80%+). */
export const ATS_REWRITE_MIN_SCORE = ATS_SCORE_TARGET_MIN;
const MAX_REWRITE_ATTEMPTS = 3;

const REWRITE_RULES = `
Rewrite this resume so it would pass a US ATS screen AND still read like a real career history.

RULES:
- Write the resume as though it existed before the candidate saw this job posting.
- Do not make the resume appear custom-written for a single company. Never name the hiring company.
- Paraphrase duties, processes, and responsibilities. Keep Salesforce product names, clouds, managed packages, and tools spelled EXACTLY as in missingKeywords / the JD (for example nCino, Financial Services Cloud, Flow Builder, Apex, Copado, Gearset, Salesforce DX).
- Put every missingKeywords item into the skills items strings using that exact spelling.
- Mention each missing product in at most one experience bullet (prefer SFA Solutions, then Amazon). Use a real project sentence, not a keyword list.
- Do not dump every JD keyword into every bullet. Do not copy generic JD phrases such as "processes and procedures" or benefits/EEO language.
- Aim for strong ATS coverage in a natural band (about ${ATS_SCORE_TARGET_MIN}–${ATS_SCORE_DISPLAY_MAX}%). Do not keyword-stuff toward a perfect 100% score.
- The resume should sound like an experienced engineer describing work completed over many years, not answering an exam.
- Role titles should be aligned with the role in the JD, with a natural career arc: earlier roles more junior / narrower, later roles closer to the target seniority and scope.
- Experience in each role must be appropriate for that point in the candidate's career — do not give the earliest job the same scope as the current one.
- Keep bullets as one long sentence each (~170–240 characters), concrete, with tools and impact.
- Skills: 6–9 categories. Dense comma-separated items. Mix exact JD product names with adjacent/broader stack so bullets stay human.
- Profile: 5–7 sentences, professional, not a paraphrase of the JD. Named products may appear once in the profile.
- Do not invent employers, dates, education, certifications, or contact details.
- If certifications are empty, keep them empty.
- Return ONLY valid JSON in the same schema as the input resume.
`.trim();

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function localRealismIssues(data, { jdText = "", jobTitle = "", companyName = "", atsReport } = {}) {
  const issues = [];
  const resumeBlob = JSON.stringify(data || {}).toLowerCase();
  const company = String(companyName || "").trim();
  if (company.length >= 5) {
    const own = new Set(
      (data?.experience || []).map((j) => normalizeName(j?.company)).filter(Boolean)
    );
    const companyKey = normalizeName(company);
    if (companyKey && !own.has(companyKey) && resumeBlob.includes(company.toLowerCase())) {
      issues.push(`Mentions the target employer (${company}); the resume looks written for this posting.`);
    }
  }

  if (Number(atsReport?.titleMatch) < 40 && String(jobTitle || "").trim()) {
    issues.push(`Role titles are weakly aligned with the JD title (${jobTitle}).`);
  }

  const jd = String(jdText || "").toLowerCase();
  const bullets = (data?.experience || [])
    .flatMap((j) => (Array.isArray(j?.bullets) ? j.bullets : []))
    .join(" ")
    .toLowerCase();
  if (jd.length > 200 && bullets.length > 200) {
    const jdChunks = jd
      .split(/[.;\n]/)
      .map((s) => s.replace(/[^a-z0-9+#./ ]+/g, " ").replace(/\s+/g, " ").trim())
      .filter((s) => s.length >= 40 && s.length <= 120);
    let copied = 0;
    for (const chunk of jdChunks.slice(0, 12)) {
      const probe = chunk.slice(0, 48);
      if (probe.length >= 28 && bullets.includes(probe)) copied += 1;
    }
    if (copied >= 2) {
      issues.push("Experience bullets echo JD phrasing instead of sounding like prior work.");
    }
  }

  const titles = (data?.experience || []).map((j) => normalizeName(j?.title)).filter(Boolean);
  const uniqueTitles = new Set(titles);
  if (titles.length >= 3 && uniqueTitles.size === 1) {
    issues.push("Every role uses the same title; career growth is not visible.");
  }

  return issues;
}

function compactForJudge(data) {
  return {
    headline: data?.headline || "",
    profile: String(data?.profile || "").slice(0, 900),
    skills: (data?.skills || []).slice(0, 9).map((row) =>
      typeof row === "string"
        ? row
        : `${row?.category || ""}: ${String(row?.items || "").slice(0, 180)}`
    ),
    experience: (data?.experience || []).map((job) => ({
      title: job?.title || "",
      company: job?.company || "",
      dates: job?.dates || "",
      bullets: (job?.bullets || []).slice(0, 3)
    }))
  };
}

function applyLockedIdentity(original, rewritten) {
  if (!rewritten || typeof rewritten !== "object") return original;
  const origJobs = Array.isArray(original?.experience) ? original.experience : [];
  const newJobs = Array.isArray(rewritten.experience) ? rewritten.experience : [];

  const experience = origJobs.map((src, index) => {
    const byCompany = newJobs.find(
      (j) => normalizeName(j?.company) && normalizeName(j.company) === normalizeName(src.company)
    );
    const match = byCompany || newJobs[index] || {};
    const bullets = Array.isArray(match.bullets) && match.bullets.filter(Boolean).length
      ? match.bullets
      : src.bullets;
    return {
      ...src,
      title: String(match.title || src.title || "").trim(),
      project: match.project != null ? match.project : src.project,
      bullets
    };
  });

  return {
    ...original,
    headline: String(rewritten.headline || original.headline || "").trim(),
    profile: String(rewritten.profile || original.profile || "").trim() || original.profile,
    skills: rewritten.skills || original.skills,
    experience
  };
}

function withAtsMeta(report, extra = {}) {
  const merged = { ...(report || {}), ...extra };
  const finalScore = toDisplayAtsScore(merged.finalScore ?? merged.score);
  merged.score = finalScore;
  merged.finalScore = finalScore;
  if (Number.isFinite(Number(merged.previousScore))) {
    merged.previousScore = toDisplayAtsScore(merged.previousScore);
  }
  return merged;
}

async function judgeResumeRealism(data, { apiKey, model, jdText, jobTitle, atsReport }) {
  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content:
          'Return ONLY JSON: {"realistic":true,"customWrittenForThisJob":false,"issues":[]}. ' +
          "realistic=false if titles/scope do not fit a real career arc, bullets sound like JD answers, " +
          "or tech families are dumped feature-by-feature. customWrittenForThisJob=true if it would be obvious " +
          "this document was built for one posting."
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            jobTitle: jobTitle || "",
            atsScore: atsReport?.score,
            titleMatch: atsReport?.titleMatch,
            missingKeywords: atsReport?.missing || [],
            jobDescriptionExcerpt: String(jdText || "").slice(0, 3500),
            resume: compactForJudge(data)
          },
          null,
          2
        )
      }
    ]
  });

  await logLlmCall({
    purpose: "resume-ats-judge",
    model,
    inputTokens: result.usage?.prompt_tokens,
    outputTokens: result.usage?.completion_tokens
  });

  const parsed = parseJsonObject(result.content) || {};
  return {
    realistic: parsed.realistic !== false,
    customWrittenForThisJob: parsed.customWrittenForThisJob === true,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map((x) => String(x || "").trim()).filter(Boolean) : []
  };
}

async function rewriteResumeJson(data, { apiKey, model, jdText, jobTitle, companyName, atsReport, issues }) {
  const locked = {
    name: data?.name,
    location: data?.location,
    email: data?.email,
    phone: data?.phone,
    linkedin: data?.linkedin,
    education: data?.education,
    certifications: Array.isArray(data?.certifications) ? data.certifications : [],
    experienceLock: (data?.experience || []).map((job) => ({
      company: job?.company || "",
      location: job?.location || "",
      dates: job?.dates || "",
      keepBulletCount: Array.isArray(job?.bullets) ? job.bullets.length : 8
    }))
  };

  const result = await chatCompletion({
    apiKey,
    model,
    jsonMode: true,
    temperature: 0.45,
    maxTokens: 16384,
    messages: [
      { role: "system", content: REWRITE_RULES },
      {
        role: "user",
        content: JSON.stringify(
          {
            targetJobTitle: jobTitle || "",
            doNotNameThisCompany: companyName || "",
            atsScore: atsReport?.score,
            titleMatch: atsReport?.titleMatch,
            skillsCoverage: atsReport?.skillsCoverage,
            keywordCoverage: atsReport?.keywordCoverage,
            missingKeywords: atsReport?.missing || [],
            plantTheseExactTermsInSkills: atsReport?.plantableMissing || atsReport?.criticalMissing || atsReport?.missing || [],
            issuesToFix: issues || [],
            lockedIdentity: locked,
            currentResume: data,
            jobDescription: String(jdText || "").slice(0, 8000)
          },
          null,
          2
        )
      },
      {
        role: "user",
        content:
          "Return the COMPLETE rewritten resume JSON now. Keep lockedIdentity employers, dates, education, contact, and certification list. Align the latest title with the target job title; earlier titles should show career growth. Put every plantTheseExactTermsInSkills value into skills items with that exact spelling. Mention each missing product in at most one SFA Solutions or Amazon bullet."
      }
    ]
  });

  await logLlmCall({
    purpose: "resume-ats-rewrite",
    model,
    inputTokens: result.usage?.prompt_tokens,
    outputTokens: result.usage?.completion_tokens
  });

  const next = extractResumeJson(result.content || "");
  if (!next) return null;
  return applyLockedIdentity(data, next);
}

function needsRewrite(atsReport, localIssues, judge) {
  // Hard rule: under 80% must rewrite.
  if (Number(atsReport?.score) < ATS_REWRITE_MIN_SCORE) return true;
  if ((atsReport?.criticalMissing || []).length) return true;
  if (localIssues.length) return true;
  if (judge && (judge.realistic === false || judge.customWrittenForThisJob === true)) return true;
  return false;
}

/**
 * @returns {Promise<{ data: object, atsReport: object }>}
 */
export async function ensureAtsReadyResume(
  data,
  { apiKey, model, jdText = "", jobTitle = "", companyName = "", setStatus } = {}
) {
  const scoreOpts = { jdText, jobTitle, apiKey, model };
  let current = data;
  const status = async (text) => {
    if (typeof setStatus === "function") await setStatus(text);
  };
  await status("Asking GPT for ATS score vs the job description...");
  let atsReport = await scoreResumeAgainstJd(current, scoreOpts);
  const previousScore = atsReport.score;

  // Fast path: 80%+ with no critical product gaps → accept without rewrite.
  if (
    Number(atsReport.score) >= ATS_REWRITE_MIN_SCORE &&
    !(atsReport?.criticalMissing || []).length
  ) {
    await status(`ATS ${atsReport.score}% (>= ${ATS_REWRITE_MIN_SCORE}%) — keeping this resume.`);
    return {
      data: current,
      atsReport: withAtsMeta(atsReport, {
        rewritten: false,
        rewriteAttempts: 0,
        previousScore,
        finalScore: atsReport.score
      })
    };
  }

  let localIssues = localRealismIssues(current, { jdText, jobTitle, companyName, atsReport });
  let judge = null;
  if (Number(atsReport.score) < ATS_REWRITE_MIN_SCORE) {
    await status(
      `ATS ${atsReport.score}% is below ${ATS_REWRITE_MIN_SCORE}% — rewriting resume...`
    );
  } else {
    await status(
      `ATS ${atsReport.score}% but critical JD products are missing — rewriting resume...`
    );
  }

  const collectedIssues = [
    ...localIssues,
    atsReport.score < ATS_REWRITE_MIN_SCORE
      ? `ATS score ${atsReport.score} is below ${ATS_REWRITE_MIN_SCORE}.`
      : "",
    (atsReport?.criticalMissing || []).length
      ? `Named JD products still missing: ${atsReport.criticalMissing.join(", ")}.`
      : ""
  ].filter(Boolean);

  let attempts = 0;
  while (attempts < MAX_REWRITE_ATTEMPTS && needsRewrite(atsReport, localIssues, judge)) {
    attempts += 1;
    await status(
      `ATS ${atsReport.score}% — rewrite pass ${attempts}/${MAX_REWRITE_ATTEMPTS} (need ${ATS_REWRITE_MIN_SCORE}%+)...`
    );
    const rewritten = await rewriteResumeJson(current, {
      apiKey,
      model,
      jdText,
      jobTitle,
      companyName,
      atsReport,
      issues: collectedIssues
    });
    if (!rewritten) break;
    current = rewritten;
    atsReport = await scoreResumeAgainstJd(current, scoreOpts);
    localIssues = localRealismIssues(current, { jdText, jobTitle, companyName, atsReport });
    judge = null;
    // Accept as soon as we hit 80%+ without critical product gaps.
    if (
      Number(atsReport.score) >= ATS_REWRITE_MIN_SCORE &&
      !(atsReport?.criticalMissing || []).length
    ) {
      await status(`ATS ${atsReport.score}% after rewrite — keeping this resume.`);
      break;
    }
    collectedIssues.push(
      `After rewrite ${attempts}: ATS ${atsReport.score}. Missing: ${(atsReport.missing || []).join(", ")}`
    );
  }

  return {
    data: current,
    atsReport: withAtsMeta(atsReport, {
      rewritten: attempts > 0,
      rewriteAttempts: attempts,
      previousScore,
      finalScore: atsReport.score,
      rewriteIssues: collectedIssues.slice(0, 8)
    })
  };
}
