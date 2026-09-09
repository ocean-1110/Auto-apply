import { PROMPT as charlytonPrompt } from "./prompts/charlyton.js";
import { PROMPT as stevenAvonPrompt } from "./prompts/steven-avon.js";
import { PROMPT as coverLetterPrompt } from "./prompts/cover-letter.js";
import { deleteApplicantInfo, getApplicantInfo } from "./applicant-info.js";

export const COVER_LETTER_PROFILE_ID = "cover-letter";

/** Built-in prompts shipped as separate files under /prompts. */
export const BUILTIN_PROFILES = [
  {
    id: "steven-avon",
    label: "Steven Avon (Salesforce)",
    promptTemplate: stevenAvonPrompt,
    templateId: "times-classic",
    builtin: true,
    kind: "resume"
  },
  {
    id: "charlyton",
    label: "Charlyton Santana",
    promptTemplate: charlytonPrompt,
    templateId: "classic-blue",
    builtin: true,
    kind: "resume"
  },
  {
    id: COVER_LETTER_PROFILE_ID,
    label: "CoverLetter",
    promptTemplate: coverLetterPrompt,
    builtin: true,
    kind: "coverLetter"
  }
];

export const DEFAULT_PROFILE_ID = BUILTIN_PROFILES.find((p) => p.kind === "resume")?.id || BUILTIN_PROFILES[0].id;

/** @deprecated Use BUILTIN_PROFILES or getAllProfiles(). */
export const PROFILES = BUILTIN_PROFILES;

const CUSTOM_PROFILES_KEY = "custom_profiles";

function slugify(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "profile";
}

/**
 * Placeholders a prompt template may use: {JD} (required), {JOB_TITLE},
 * {COMPANY}, {CANDIDATE_INFORMATION}, {PROJECT_MANIFESTS}. The shorter
 * *_INFO / *_MANIFEST spellings are accepted aliases.
 */
const CANDIDATE_INFO_TOKENS = ["{CANDIDATE_INFORMATION}", "{CANDIDATE_INFO}"];
const PROJECT_MANIFEST_TOKENS = ["{PROJECT_MANIFESTS}", "{PROJECT_MANIFEST}"];

function hasAnyToken(template, tokens) {
  return tokens.some((token) => template.includes(token));
}

function applyPlaceholders(
  template,
  {
    jdText = "",
    jobTitle = "",
    companyName = "",
    candidateInfo = "",
    projectManifests = ""
  } = {}
) {
  let out = template
    .replaceAll("{JD}", jdText)
    .replaceAll("{JOB_TITLE}", jobTitle)
    .replaceAll("{COMPANY}", companyName);
  // An empty slot becomes an explicit "none" so the template's own heading is
  // not left dangling above nothing.
  for (const token of CANDIDATE_INFO_TOKENS) {
    out = out.replaceAll(token, candidateInfo || "(none provided)");
  }
  for (const token of PROJECT_MANIFEST_TOKENS) {
    out = out.replaceAll(token, projectManifests || "(none provided)");
  }
  return out;
}

/** Free-form candidate source-of-truth text saved on a profile. */
export async function getCandidateInfoText(profileId) {
  if (!profileId) return "";
  const info = await getApplicantInfo(profileId);
  return String(info?.candidateInfo || "").trim();
}

export async function getCustomProfiles() {
  const data = await chrome.storage.local.get(CUSTOM_PROFILES_KEY);
  const list = data[CUSTOM_PROFILES_KEY];
  return Array.isArray(list) ? list : [];
}

export async function getAllProfiles() {
  const custom = await getCustomProfiles();
  return [
    ...BUILTIN_PROFILES,
    ...custom.map((p) => ({ ...p, builtin: false, kind: p.kind || "resume" }))
  ];
}

/** Profiles shown in the resume generator dropdown (excludes CoverLetter). */
export async function getResumeProfiles() {
  const profiles = await getAllProfiles();
  return profiles.filter((p) => p.kind !== "coverLetter" && p.id !== COVER_LETTER_PROFILE_ID);
}

export async function getProfileById(profileId) {
  const profiles = await getAllProfiles();
  return profiles.find((p) => p.id === profileId) || profiles.find((p) => p.kind === "resume") || profiles[0];
}

export async function getCoverLetterProfile() {
  const profiles = await getAllProfiles();
  const customOverride = [...profiles]
    .reverse()
    .find(
      (p) =>
        !p.builtin &&
        (p.kind === "coverLetter" ||
          String(p.label || "").toLowerCase().replace(/\s+/g, "") === "coverletter")
    );
  if (customOverride) return customOverride;

  return (
    profiles.find((p) => p.id === COVER_LETTER_PROFILE_ID) ||
    profiles.find((p) => p.kind === "coverLetter") ||
    null
  );
}

/**
 * Fill a profile's prompt template for one job.
 *
 * Candidate information and the JD-matched project manifest go into the
 * template's own {CANDIDATE_INFORMATION} / {PROJECT_MANIFESTS} slots when it
 * has them. Templates written before those placeholders existed still get the
 * content — appended at the end with its own heading — so nothing is silently
 * dropped.
 *
 * @param {object} extras
 * @param {string} [extras.candidateInfo] override; defaults to the profile's saved text
 * @param {string} [extras.projectManifests] ranked project list for the placeholder
 * @param {string} [extras.projectManifestBlock] projects + usage rules, for the append fallback
 */
export async function buildPrompt(profileId, jdText, extras = {}) {
  const profile = await getProfileById(profileId);
  const promptTemplate = await getEffectivePromptTemplate(profile);
  if (!promptTemplate) {
    throw new Error("Selected profile has no prompt content.");
  }
  if (!promptTemplate.includes("{JD}")) {
    throw new Error('Prompt must include the {JD} placeholder.');
  }

  const candidateInfo =
    extras.candidateInfo !== undefined
      ? String(extras.candidateInfo || "").trim()
      : await getCandidateInfoText(profileId);
  const projectManifests = String(extras.projectManifests || "").trim();

  const prompt = applyPlaceholders(promptTemplate, {
    jdText,
    jobTitle: extras.jobTitle || "",
    companyName: extras.companyName || "",
    candidateInfo,
    projectManifests
  });

  const tail = [];
  if (candidateInfo && !hasAnyToken(promptTemplate, CANDIDATE_INFO_TOKENS)) {
    tail.push(
      [
        "=== CANDIDATE INFORMATION — SOURCE OF TRUTH ===",
        "",
        "Employers, dates, titles, technologies, and metrics below are verified. Do not contradict them, and do not claim anything this section cannot support.",
        "",
        candidateInfo
      ].join("\n")
    );
  }
  const manifestBlock = String(extras.projectManifestBlock || "").trim();
  if (manifestBlock && !hasAnyToken(promptTemplate, PROJECT_MANIFEST_TOKENS)) {
    tail.push(manifestBlock);
  }

  return tail.length ? [prompt, ...tail].join("\n\n") : prompt;
}

export async function buildCoverLetterPrompt({
  jdText,
  jobTitle,
  companyName,
  profileId = "",
  projectManifests = ""
}) {
  const profile = await getCoverLetterProfile();
  const promptTemplate = await getEffectivePromptTemplate(profile);
  if (!promptTemplate) {
    throw new Error('CoverLetter profile is missing. Add a built-in or custom profile titled "CoverLetter".');
  }
  if (!promptTemplate.includes("{JD}")) {
    throw new Error("CoverLetter prompt must include the {JD} placeholder.");
  }
  // Candidate info comes from the resume profile being generated, not the
  // CoverLetter profile, which usually holds only a prompt.
  const candidateInfo = await getCandidateInfoText(profileId);
  return applyPlaceholders(promptTemplate, {
    jdText,
    jobTitle,
    companyName,
    candidateInfo,
    projectManifests
  });
}

function resolveProfileKind(kind, name) {
  return kind === "coverLetter" || name.toLowerCase().replace(/\s+/g, "") === "coverletter"
    ? "coverLetter"
    : "resume";
}

function validatePrompt(prompt) {
  if (!prompt) throw new Error("Prompt content is required.");
  if (!prompt.includes("{JD}")) {
    throw new Error('Prompt content must include {JD} where the job description goes.');
  }
}

export async function addCustomProfile({ label, promptTemplate, kind = "resume" }) {
  const name = String(label || "").trim();
  const prompt = String(promptTemplate || "").trim();

  if (!name) throw new Error("Profile name is required.");
  validatePrompt(prompt);

  const custom = await getCustomProfiles();
  const idBase = slugify(name);
  let id = `custom-${idBase}`;
  let n = 2;
  const used = new Set([
    ...BUILTIN_PROFILES.map((p) => p.id),
    ...custom.map((p) => p.id)
  ]);
  while (used.has(id)) {
    id = `custom-${idBase}-${n}`;
    n += 1;
  }

  const profile = {
    id,
    label: name,
    promptTemplate: prompt,
    kind: resolveProfileKind(kind, name)
  };
  custom.push(profile);
  await chrome.storage.local.set({ [CUSTOM_PROFILES_KEY]: custom });
  return profile;
}

/** Update name/prompt for a custom profile. Built-ins cannot be renamed this way. */
export async function updateCustomProfile(profileId, { label, promptTemplate, kind } = {}) {
  const custom = await getCustomProfiles();
  const index = custom.findIndex((p) => p.id === profileId);
  if (index < 0) {
    throw new Error("Only profiles you added can be edited.");
  }

  const current = custom[index];
  const name = label !== undefined ? String(label || "").trim() : current.label;
  const prompt =
    promptTemplate !== undefined ? String(promptTemplate || "").trim() : current.promptTemplate;

  if (!name) throw new Error("Profile name is required.");
  validatePrompt(prompt);

  const nextKind =
    kind !== undefined ? resolveProfileKind(kind, name) : resolveProfileKind(current.kind, name);

  custom[index] = {
    ...current,
    label: name,
    promptTemplate: prompt,
    kind: nextKind
  };
  await chrome.storage.local.set({ [CUSTOM_PROFILES_KEY]: custom });
  return custom[index];
}

/**
 * Prompt overrides for built-in profiles (stored separately so shipped files stay intact).
 * Custom profiles always use their own promptTemplate.
 */
const PROMPT_OVERRIDES_KEY = "builtin_prompt_overrides";

export async function getPromptOverrides() {
  const data = await chrome.storage.local.get(PROMPT_OVERRIDES_KEY);
  const map = data[PROMPT_OVERRIDES_KEY];
  return map && typeof map === "object" ? map : {};
}

export async function getEffectivePromptTemplate(profile) {
  if (!profile) return "";
  if (!profile.builtin) return profile.promptTemplate || "";
  const overrides = await getPromptOverrides();
  const override = overrides[profile.id];
  return typeof override === "string" && override.trim() ? override : profile.promptTemplate || "";
}

export async function saveBuiltinPromptOverride(profileId, promptTemplate) {
  const builtin = BUILTIN_PROFILES.find((p) => p.id === profileId);
  if (!builtin) {
    throw new Error("Prompt override is only for built-in profiles. Edit custom profiles directly.");
  }
  const prompt = String(promptTemplate || "").trim();
  validatePrompt(prompt);
  const overrides = await getPromptOverrides();
  overrides[profileId] = prompt;
  await chrome.storage.local.set({ [PROMPT_OVERRIDES_KEY]: overrides });
  return prompt;
}

export async function clearBuiltinPromptOverride(profileId) {
  const overrides = await getPromptOverrides();
  if (!(profileId in overrides)) return;
  delete overrides[profileId];
  await chrome.storage.local.set({ [PROMPT_OVERRIDES_KEY]: overrides });
}

export async function deleteCustomProfile(profileId) {
  const custom = await getCustomProfiles();
  const next = custom.filter((p) => p.id !== profileId);
  if (next.length === custom.length) {
    throw new Error("Only profiles you added can be deleted.");
  }
  await chrome.storage.local.set({ [CUSTOM_PROFILES_KEY]: next });
  await deleteApplicantInfo(profileId);
}
