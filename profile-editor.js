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
  resetBuiltinPrompt: document.getElementById("resetBuiltinPrompt"),
  saveBtn: document.getElementById("saveBtn"),
  saveBtnBottom: document.getElementById("saveBtnBottom"),
  cancelBtn: document.getElementById("cancelBtn"),
  cancelBtnBottom: document.getElementById("cancelBtnBottom")
};

/** @type {{ mode: "new" | "edit", profileId: string | null, builtin: boolean }} */
let editorState = { mode: "new", profileId: null, builtin: false };

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.style.color = isError ? "#fca5a5" : "#93c5fd";
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

loadEditor()
  .then(() => integrations.load())
  .catch((err) => setStatus(`Init failed: ${String(err.message || err)}`, true));
