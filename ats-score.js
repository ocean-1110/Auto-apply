/**
 * Local ATS-style keyword coverage report for a generated resume vs JD.
 * Deterministic (no extra API call) so the popup can always show a score.
 *
 * Displayed overall scores are kept in a realistic band (up to 90%).
 * Rewrite pipeline targets at least 75%.
 */

export const ATS_SCORE_DISPLAY_MAX = 90;
export const ATS_SCORE_TARGET_MIN = 75;

const STOP = new Set(
  `
  a an the and or of to for in on with from by as at is are was were be been being
  this that these those it its their your you we our they them i me my
  will would should can could may might must
  job jobs role roles position positions candidate candidates applicant
  team teams company companies work working worked
  including include includes required require requirements preferred prefer
  experience experienced years year plus strong ability able
  using use used such other any all both not
  description responsibilities responsibility qualification qualifications
  about who what when where how why
  `.trim().split(/\s+/)
);

const TECH_KEEP = /[+#.]|[A-Z][a-z]+[A-Z]|salesforce|apex|lwc|aws|azure|gcp|sql|python|java|react|node|cloud|api|etl|spark|snowflake|databricks|airflow|kafka/i;

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9+#./ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalize(text)
    .split(/[\s,/|;]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

function unique(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = String(item || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

const PHRASE_STOP = new Set(
  `
  need needs needed looking seeking hire hiring join joining please ideal plus
  must should including include includes required require preferred prefer
  strong proven excellent outstanding successful
  senior junior staff lead principal intern
  developer engineer consultant administrator architect analyst manager
  description responsibilities qualification qualifications benefit benefits
  `.trim().split(/\s+/)
);

function looksTechnical(term) {
  if (TECH_KEEP.test(term)) return true;
  if (term.includes("#") || term.includes("+") || term.includes(".")) return true;
  if (term.includes(" ")) {
    const parts = term.split(" ");
    return parts.some((p) => TECH_KEEP.test(p) || p.length >= 6);
  }
  return term.length >= 6;
}

function phraseCandidates(text) {
  const words = tokenize(text);
  const phrases = [];
  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i];
    const b = words[i + 1];
    if (STOP.has(a) || STOP.has(b) || PHRASE_STOP.has(a) || PHRASE_STOP.has(b)) continue;
    if (!looksTechnical(a) && !looksTechnical(b)) continue;
    phrases.push(`${a} ${b}`);
  }
  return phrases;
}

function extractJdKeywords(jdText, jobTitle = "") {
  const jd = String(jdText || "");
  const singles = tokenize(jd).filter((t) => looksTechnical(t) && !PHRASE_STOP.has(t));
  const phrases = phraseCandidates(jd).filter((p) => p.length >= 7 && looksTechnical(p));
  const titleTerms = tokenize(jobTitle).filter((t) => t.length >= 3 && !STOP.has(t));

  const counts = new Map();
  for (const term of [...phrases, ...singles]) {
    counts.set(term, (counts.get(term) || 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => {
      const phraseBoost = (x) => (String(x[0]).includes(" ") ? 8 : 0) + String(x[0]).length / 10;
      return b[1] + phraseBoost(b) - (a[1] + phraseBoost(a));
    })
    .map(([term]) => term);

  const keywords = unique([...titleTerms, ...ranked]).slice(0, 48);
  return { keywords, titleTerms };
}

function resumeCorpus(resumeData = {}) {
  const skills = Array.isArray(resumeData.skills)
    ? resumeData.skills
        .map((row) =>
          typeof row === "string"
            ? row
            : [row?.category, row?.items, row?.skills, row?.technologies].filter(Boolean).join(" ")
        )
        .join(" ")
    : "";
  const jobs = Array.isArray(resumeData.experience) ? resumeData.experience : [];
  const titles = jobs.map((j) => [j?.title, j?.company, j?.project].filter(Boolean).join(" ")).join(" ");
  const bullets = jobs
    .flatMap((j) => (Array.isArray(j?.bullets) ? j.bullets : []))
    .join(" ");
  const edu = resumeData.education || {};
  return {
    all: normalize(
      [
        resumeData.name,
        resumeData.headline,
        resumeData.profile,
        skills,
        titles,
        bullets,
        edu.school,
        edu.degree,
        Array.isArray(resumeData.certifications) ? resumeData.certifications.join(" ") : ""
      ].join(" ")
    ),
    skills: normalize(skills),
    titles: normalize(`${resumeData.headline || ""} ${titles}`),
    experience: normalize(`${titles} ${bullets}`)
  };
}

function foundIn(haystack, term) {
  const t = normalize(term);
  if (!t || !haystack) return false;
  if (t.includes(" ")) return haystack.includes(t);
  const re = new RegExp(`(?:^|[^a-z0-9+#])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9+#])`, "i");
  return re.test(haystack);
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((100 * part) / whole);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Map a raw coverage score into the display band.
 * Never shows 91–100 (those look fake); keeps strong resumes in ~75–90.
 */
export function toDisplayAtsScore(raw) {
  const n = clamp(Math.round(Number(raw) || 0), 0, 100);
  if (n <= ATS_SCORE_DISPLAY_MAX) return n;
  // Compress 91–100 into 88–90 so almost-perfect coverage still caps at 90.
  return clamp(88 + Math.round((n - 90) * 0.2), 88, ATS_SCORE_DISPLAY_MAX);
}

/**
 * @returns {{
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
 *   jobTitle: string
 * }}
 */
export function scoreResumeAgainstJd(resumeData = {}, { jdText = "", jobTitle = "" } = {}) {
  const { keywords, titleTerms } = extractJdKeywords(jdText, jobTitle);
  const corpus = resumeCorpus(resumeData);

  const titleHits = titleTerms.filter((t) => foundIn(corpus.titles, t));
  const titleMatch = titleTerms.length ? pct(titleHits.length, titleTerms.length) : 70;

  const skillTerms = keywords.filter((k) => k.includes(" ") || TECH_KEEP.test(k)).slice(0, 28);
  const skillHits = (skillTerms.length ? skillTerms : keywords.slice(0, 20)).filter((t) =>
    foundIn(corpus.skills, t) || foundIn(corpus.all, t)
  );
  const skillsDenom = skillTerms.length || Math.min(keywords.length, 20);
  const skillsCoverage = skillsDenom ? pct(skillHits.length, skillsDenom) : 0;

  const keywordHits = keywords.filter((t) => foundIn(corpus.all, t));
  const keywordCoverage = keywords.length ? pct(keywordHits.length, keywords.length) : 0;

  const jobs = Array.isArray(resumeData.experience) ? resumeData.experience : [];
  const experienceAlignment = clamp(pct(Math.min(jobs.length, 6), 6), 40, 100);

  const strongMatches = unique(
    keywords.filter((t) => foundIn(corpus.skills, t) && foundIn(corpus.experience, t))
  ).slice(0, 10);
  const missing = keywords.filter((t) => !foundIn(corpus.all, t)).slice(0, 8);

  const rawScore = clamp(
    Math.round(
      titleMatch * 0.18 +
        skillsCoverage * 0.4 +
        keywordCoverage * 0.32 +
        experienceAlignment * 0.1
    ),
    0,
    100
  );
  const score = toDisplayAtsScore(rawScore);

  return {
    score,
    rawScore,
    finalScore: score,
    titleMatch,
    skillsCoverage,
    keywordCoverage,
    experienceAlignment,
    matchedCount: keywordHits.length,
    totalKeywords: keywords.length,
    strongMatches,
    missing,
    jobTitle: String(jobTitle || "").trim()
  };
}

export function formatAtsTooltip(report) {
  if (!report) return "";
  const finalScore = Math.round(Number(report.finalScore ?? report.score) || 0);
  const lines = [`Final ATS score: ${finalScore}%`];
  if (report.rewritten && Number.isFinite(Number(report.previousScore))) {
    lines.push(
      `After rewrite (was ${Math.round(Number(report.previousScore))}%)`
    );
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
  lines.push(`Score band: ${ATS_SCORE_TARGET_MIN}–${ATS_SCORE_DISPLAY_MAX}% (never shown above ${ATS_SCORE_DISPLAY_MAX}%)`);
  return lines.join("\n");
}
