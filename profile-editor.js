import {
  getProfileById,
  addCustomProfile,
  updateCustomProfile,
  getEffectivePromptTemplate,
  saveBuiltinPromptOverride,
  clearBuiltinPromptOverride
} from "./profiles.js";
import {
  getApplicantInfo,
  saveApplicantInfo,
  createEmptyApplicantInfo,
  US_STATES,
  YES_NO_OPTIONS,
  DEGREE_OPTIONS,
  GENDER_OPTIONS,
  RACE_OPTIONS,
  VETERAN_OPTIONS,
  DISABILITY_OPTIONS,
  ENGLISH_LEVEL_OPTIONS,
  HISPANIC_OPTIONS
} from "./applicant-info.js";
import { closeHostWindow } from "./close-host.js";
import { initIntegrationsSettings } from "./integrations-settings.js";
import { parseProjectManifest } from "./project-manifest.js";
import {
  saveOutputDirectoryHandle,
  getOutputDirectoryName,
  getOutputDirectoryAbsolutePath,
  setOutputDirectoryAbsolutePath,
  unlockOutputDirectory
} from "./fs-output.js";

const RESUME_FILENAME_PATTERN_KEY = "resume_filename_pattern";
const DEFAULT_RESUME_FILENAME_PATTERN = "{name}_Resume";

const APPLICANT_FIELD_IDS = Object.keys(createEmptyApplicantInfo());

const SELECT_OPTIONS = {
  state: US_STATES,
  workAuthorized: YES_NO_OPTIONS,
  needsSponsorship: YES_NO_OPTIONS,
  postEmploymentRestrictions: YES_NO_OPTIONS,
  willingToRelocate: YES_NO_OPTIONS,
  over18: YES_NO_OPTIONS,
  felonyConviction: YES_NO_OPTIONS,
  highestDegree: DEGREE_OPTIONS,
  englishLevel: ENGLISH_LEVEL_OPTIONS,
  backgroundCheckConsent: YES_NO_OPTIONS,
  drugTestConsent: YES_NO_OPTIONS,
  gender: GENDER_OPTIONS,
  hispanicLatino: HISPANIC_OPTIONS,
  raceEthnicity: RACE_OPTIONS,
  veteranStatus: VETERAN_OPTIONS,
  disabilityStatus: DISABILITY_OPTIONS
};

const els = {
  pageTitle: document.getElementById("pageTitle"),
  status: document.getElementById("status"),
  profileLabel: document.getElementById("profileLabel"),
  profileKind: document.getElementById("profileKind"),
  builtinHint: document.getElementById("builtinHint"),
  kindHint: document.getElementById("kindHint"),
  promptTemplate: document.getElementById("promptTemplate"),
  candidateInfo: document.getElementById("candidateInfo"),
  candidateInfoNote: document.getElementById("candidateInfoNote"),
  projectManifest: document.getElementById("projectManifest"),
  projectManifestNote: document.getElementById("projectManifestNote"),
  resetBuiltinPrompt: document.getElementById("resetBuiltinPrompt"),
  saveBtn: document.getElementById("saveBtn"),
  saveBtnBottom: document.getElementById("saveBtnBottom"),
  cancelBtn: document.getElementById("cancelBtn"),
  cancelBtnBottom: document.getElementById("cancelBtnBottom"),
  outputDirLabel: document.getElementById("outputDirLabel"),
  outputDirAbsPath: document.getElementById("outputDirAbsPath"),
  resumeFilenamePattern: document.getElementById("resumeFilenamePattern"),
  resumeFilenameExample: document.getElementById("resumeFilenameExample"),
  selectOutputDir: document.getElementById("selectOutputDir")
};

/** @type {{ mode: "new" | "edit", profileId: string | null, builtin: boolean }} */
let editorState = { mode: "new", profileId: null, builtin: false };

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.style.color = isError ? "#fca5a5" : "#93c5fd";
}

function previewResumeFilename(pattern) {
  const tokens = {
    name: "Steven_Avon",
    fullname: "Steven Avon",
    first: "Steven",
    last: "Avon",
    company: "Acme",
    title: "Engineer",
    role: "Engineer",
    date: new Date().toISOString().slice(0, 10)
  };
  let out = String(pattern || "").trim() || DEFAULT_RESUME_FILENAME_PATTERN;
  out = out.replace(/\.(pdf|html)$/i, "");
  out = out.replace(/\{([a-z_]+)\}/gi, (_, key) => {
    const value = tokens[String(key || "").toLowerCase()];
    return value != null ? String(value) : "";
  });
  out = out.replace(/\s+/g, "_").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  out = out.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "Resume";
  return `${out}.pdf`;
}

function updateResumeFilenameExample() {
  if (!els.resumeFilenameExample) return;
  const pattern = els.resumeFilenamePattern?.value || DEFAULT_RESUME_FILENAME_PATTERN;
  els.resumeFilenameExample.textContent = previewResumeFilename(pattern);
}

async function loadResumeFilenamePattern() {
  const data = await chrome.storage.local.get(RESUME_FILENAME_PATTERN_KEY);
  const raw = String(data[RESUME_FILENAME_PATTERN_KEY] || "").trim();
  if (els.resumeFilenamePattern) {
    els.resumeFilenamePattern.value = raw || DEFAULT_RESUME_FILENAME_PATTERN;
  }
  updateResumeFilenameExample();
}

async function persistResumeFilenamePattern() {
  if (!els.resumeFilenamePattern) return;
  let value = String(els.resumeFilenamePattern.value || "").trim();
  if (!value) value = DEFAULT_RESUME_FILENAME_PATTERN;
  els.resumeFilenamePattern.value = value;
  await chrome.storage.local.set({ [RESUME_FILENAME_PATTERN_KEY]: value });
  updateResumeFilenameExample();
}

async function refreshOutputDirLabel() {
  const name = await getOutputDirectoryName();
  if (els.outputDirLabel) {
    els.outputDirLabel.value = name || "";
    els.outputDirLabel.placeholder = name ? name : "No folder selected";
  }
  if (els.outputDirAbsPath) {
    const abs = await getOutputDirectoryAbsolutePath();
    els.outputDirAbsPath.value = abs || "";
    els.outputDirAbsPath.placeholder = name
      ? `Paste full path to "${name}" (e.g. D:\\Bid\\BR-AI\\${name})`
      : "e.g. D:\\Bid\\BR-AI\\09-01W";
  }
}

async function persistOutputAbsolutePathFromInput() {
  if (!els.outputDirAbsPath) return "";
  const path = await setOutputDirectoryAbsolutePath(els.outputDirAbsPath.value);
  els.outputDirAbsPath.value = path;
  return path;
}

async function selectOutputDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus("Folder picker is not supported in this Chrome build.", true);
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: "resume-bot-output",
      mode: "readwrite",
      startIn: "documents"
    });
    const name = await saveOutputDirectoryHandle(handle);
    await unlockOutputDirectory({ interactive: true });
    if (els.outputDirLabel) els.outputDirLabel.value = name;

    const prevAbs = await getOutputDirectoryAbsolutePath();
    let suggestion = prevAbs;
    if (!suggestion) {
      suggestion = `D:\\Bid\\BR-AI\\${name}`;
    } else {
      const leaf = suggestion.split(/[/\\]/).filter(Boolean).pop() || "";
      if (leaf.toLowerCase() !== String(name).toLowerCase()) {
        suggestion = `${suggestion.replace(/[\\/]+$/, "")}\\${name}`;
      }
    }
    const typed = window.prompt(
      `Chrome cannot read the full disk path.\n\nPaste the absolute path to the folder you just selected ("${name}"):`,
      suggestion
    );
    if (typed != null && String(typed).trim()) {
      const abs = await setOutputDirectoryAbsolutePath(typed);
      if (els.outputDirAbsPath) els.outputDirAbsPath.value = abs;
      setStatus(`Output folder set: ${abs || name}`);
    } else {
      setStatus(
        `Output folder set: ${name}. Paste its absolute path below so Copy path works in Explorer.`
      );
    }
    await refreshOutputDirLabel();
  } catch (err) {
    if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
      setStatus("Folder selection canceled.");
      return;
    }
    setStatus(`Folder selection failed: ${String(err?.message || err)}`, true);
  }
}

function fillSelect(selectEl, options) {
  selectEl.innerHTML = "";
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    selectEl.appendChild(option);
  }
}

function initSelects() {
  for (const [id, options] of Object.entries(SELECT_OPTIONS)) {
    const el = document.getElementById(id);
    if (el) fillSelect(el, options);
  }
}

function readApplicantFromForm() {
  const info = createEmptyApplicantInfo();
  for (const key of APPLICANT_FIELD_IDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    info[key] = String(el.value || "").trim();
  }
  return info;
}

function writeApplicantToForm(info) {
  const data = { ...createEmptyApplicantInfo(), ...info };
  for (const key of APPLICANT_FIELD_IDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.value = data[key] ?? "";
  }
  syncProjectManifestNote();
  syncCandidateInfoNote();
}

/** Confirm the field is filled and whether the prompt routes it to a placeholder. */
function syncCandidateInfoNote() {
  if (!els.candidateInfo || !els.candidateInfoNote) return;
  const chars = els.candidateInfo.value.trim().length;
  if (!chars) {
    els.candidateInfoNote.textContent =
      "Not set. Without it the model has only the prompt's own resume text to work from.";
    return;
  }
  const template = els.promptTemplate?.value || "";
  const placed = /\{CANDIDATE_INFO(RMATION)?\}/.test(template);
  els.candidateInfoNote.textContent = `${chars.toLocaleString()} characters. ${
    placed
      ? "Inserted at {CANDIDATE_INFORMATION} in the prompt."
      : "Appended to the end of the prompt (no {CANDIDATE_INFORMATION} placeholder found)."
  }`;
}

/** Show how many projects the manifest parses into, so the format is obvious while typing. */
function syncProjectManifestNote() {
  if (!els.projectManifest || !els.projectManifestNote) return;
  const count = parseProjectManifest(els.projectManifest.value).length;
  els.projectManifestNote.textContent = count
    ? `${count} project${count === 1 ? "" : "s"} detected. The ones matching each job description are used automatically.`
    : "No projects yet. Separate each project with a blank line.";
}

function parseQuery() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") === "new" ? "new" : "edit";
  const profileId = params.get("profileId") || null;
  return { mode, profileId };
}

function syncKindHint() {
  els.kindHint.hidden = els.profileKind.value !== "coverLetter";
}

function applyModeChrome() {
  const isBuiltin = editorState.builtin;
  const isNew = editorState.mode === "new";

  els.pageTitle.textContent = isNew ? "Add profile" : "Edit profile";
  els.profileLabel.disabled = isBuiltin;
  els.profileKind.disabled = isBuiltin || isNew === false && isBuiltin;
  if (isBuiltin) {
    els.profileKind.disabled = true;
  }
  els.builtinHint.hidden = !isBuiltin;
  els.resetBuiltinPrompt.hidden = !isBuiltin;
  syncKindHint();
}

async function loadEditor() {
  initSelects();
  const query = parseQuery();

  if (query.mode === "new" || !query.profileId) {
    editorState = { mode: "new", profileId: null, builtin: false };
    els.profileLabel.value = "";
    els.profileKind.value = "resume";
    els.promptTemplate.value = "";
    writeApplicantToForm(createEmptyApplicantInfo());
    applyModeChrome();
    setStatus("Fill in common application answers and a resume prompt, then save.");
    return;
  }

  const profile = await getProfileById(query.profileId);
  if (!profile) {
    editorState = { mode: "new", profileId: null, builtin: false };
    applyModeChrome();
    setStatus("Profile not found. Creating a new one instead.", true);
    writeApplicantToForm(createEmptyApplicantInfo());
    return;
  }

  editorState = {
    mode: "edit",
    profileId: profile.id,
    builtin: Boolean(profile.builtin)
  };

  els.profileLabel.value = profile.label || "";
  els.profileKind.value = profile.kind === "coverLetter" ? "coverLetter" : "resume";
  els.promptTemplate.value = await getEffectivePromptTemplate(profile);

  const applicant = await getApplicantInfo(profile.id);
  writeApplicantToForm(applicant);
  applyModeChrome();
  setStatus(`Editing: ${profile.label}`);
}

async function saveEditor() {
  const label = els.profileLabel.value;
  const promptTemplate = els.promptTemplate.value;
  const kind = els.profileKind.value === "coverLetter" ? "coverLetter" : "resume";
  const applicant = readApplicantFromForm();

  els.saveBtn.disabled = true;
  els.saveBtnBottom.disabled = true;
  setStatus("Saving...");

  try {
    let profileId = editorState.profileId;

    if (editorState.mode === "new") {
      const created = await addCustomProfile({ label, promptTemplate, kind });
      profileId = created.id;
      await saveApplicantInfo(profileId, applicant);
      await chrome.storage.local.set({ selected_profile_id: profileId });
      setStatus(`Saved new profile: ${created.label}`);
    } else if (editorState.builtin) {
      await saveBuiltinPromptOverride(profileId, promptTemplate);
      await saveApplicantInfo(profileId, applicant);
      setStatus("Saved application answers and prompt override for built-in profile.");
    } else {
      const updated = await updateCustomProfile(profileId, { label, promptTemplate, kind });
      await saveApplicantInfo(profileId, applicant);
      setStatus(`Saved: ${updated.label}`);
    }

    // Return to the main panel after a successful save.
    setTimeout(() => closeHostWindow(), 150);
  } catch (err) {
    setStatus(String(err.message || err), true);
    els.saveBtn.disabled = false;
    els.saveBtnBottom.disabled = false;
  }
}

async function resetBuiltinPrompt() {
  if (!editorState.builtin || !editorState.profileId) return;
  const ok = window.confirm("Reset prompt to the built-in default? Application answers are kept.");
  if (!ok) return;

  try {
    await clearBuiltinPromptOverride(editorState.profileId);
    const profile = await getProfileById(editorState.profileId);
    els.promptTemplate.value = profile?.promptTemplate || "";
    setStatus("Prompt reset to built-in default.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
}

function closeEditor() {
  closeHostWindow();
}

const integrations = initIntegrationsSettings({
  getProfileId: () => editorState.profileId,
  setStatus: (message, isError = false) => setStatus(message, Boolean(isError))
});

els.saveBtn.addEventListener("click", () => {
  saveEditor().catch(() => {});
});
els.saveBtnBottom.addEventListener("click", () => {
  saveEditor().catch(() => {});
});
els.profileKind.addEventListener("change", syncKindHint);
els.projectManifest?.addEventListener("input", syncProjectManifestNote);
els.candidateInfo?.addEventListener("input", syncCandidateInfoNote);
els.promptTemplate?.addEventListener("input", syncCandidateInfoNote);
els.cancelBtn.addEventListener("click", closeEditor);
els.cancelBtnBottom.addEventListener("click", closeEditor);
els.resetBuiltinPrompt.addEventListener("click", () => {
  resetBuiltinPrompt().catch(() => {});
});

document.addEventListener("keydown", (e) => {
  const key = String(e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "s") {
    e.preventDefault();
    saveEditor().catch(() => {});
  }
});

els.selectOutputDir?.addEventListener("click", () => {
  selectOutputDirectory().catch((err) => setStatus(String(err?.message || err), true));
});
els.outputDirAbsPath?.addEventListener("change", () => {
  persistOutputAbsolutePathFromInput()
    .then((path) => {
      if (path) setStatus(`Absolute path saved: ${path}`);
    })
    .catch((err) => setStatus(String(err?.message || err), true));
});
els.outputDirAbsPath?.addEventListener("blur", () => {
  persistOutputAbsolutePathFromInput().catch(() => {});
});
els.resumeFilenamePattern?.addEventListener("input", () => updateResumeFilenameExample());
els.resumeFilenamePattern?.addEventListener("change", () => {
  persistResumeFilenamePattern().catch((err) => setStatus(String(err?.message || err), true));
});
els.resumeFilenamePattern?.addEventListener("blur", () => {
  persistResumeFilenamePattern().catch(() => {});
});

loadEditor()
  .then(() => integrations.load())
  .then(() => refreshOutputDirLabel())
  .then(() => loadResumeFilenamePattern())
  .catch((err) => setStatus(`Init failed: ${String(err.message || err)}`, true));
