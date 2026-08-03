import { PROMPT as charlytonPrompt } from "./prompts/charlyton.js";
import { PROMPT as stevenAvonPrompt } from "./prompts/steven-avon.js";
import { PROMPT as coverLetterPrompt } from "./prompts/cover-letter.js";

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

function applyPlaceholders(template, { jdText = "", jobTitle = "", companyName = "" } = {}) {
  return template
    .replaceAll("{JD}", jdText)
    .replaceAll("{JOB_TITLE}", jobTitle)
    .replaceAll("{COMPANY}", companyName);
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

export async function buildPrompt(profileId, jdText, extras = {}) {
  const profile = await getProfileById(profileId);
  if (!profile?.promptTemplate) {
    throw new Error("Selected profile has no prompt content.");
  }
  if (!profile.promptTemplate.includes("{JD}")) {
    throw new Error('Prompt must include the {JD} placeholder.');
  }
  return applyPlaceholders(profile.promptTemplate, {
    jdText,
    jobTitle: extras.jobTitle || "",
    companyName: extras.companyName || ""
  });
}

export async function buildCoverLetterPrompt({ jdText, jobTitle, companyName }) {
  const profile = await getCoverLetterProfile();
  if (!profile?.promptTemplate) {
    throw new Error('CoverLetter profile is missing. Add a built-in or custom profile titled "CoverLetter".');
  }
  if (!profile.promptTemplate.includes("{JD}")) {
    throw new Error("CoverLetter prompt must include the {JD} placeholder.");
  }
  return applyPlaceholders(profile.promptTemplate, { jdText, jobTitle, companyName });
}

export async function addCustomProfile({ label, promptTemplate, kind = "resume" }) {
  const name = String(label || "").trim();
  const prompt = String(promptTemplate || "").trim();

  if (!name) throw new Error("Profile name is required.");
  if (!prompt) throw new Error("Prompt content is required.");
  if (!prompt.includes("{JD}")) {
    throw new Error('Prompt content must include {JD} where the job description goes.');
  }

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

  const profileKind =
    kind === "coverLetter" || name.toLowerCase().replace(/\s+/g, "") === "coverletter"
      ? "coverLetter"
      : "resume";

  const profile = {
    id,
    label: name,
    promptTemplate: prompt,
    kind: profileKind
  };
  custom.push(profile);
  await chrome.storage.local.set({ [CUSTOM_PROFILES_KEY]: custom });
  return profile;
}

export async function deleteCustomProfile(profileId) {
  const custom = await getCustomProfiles();
  const next = custom.filter((p) => p.id !== profileId);
  if (next.length === custom.length) {
    throw new Error("Only profiles you added can be deleted.");
  }
  await chrome.storage.local.set({ [CUSTOM_PROFILES_KEY]: next });
}
