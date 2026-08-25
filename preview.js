import { getAllTemplates, DEFAULT_TEMPLATE_ID, resumeJsonToHtml } from "./templates/index.js";
import { buildCoverLetterHtml } from "./cover-letter-html.js";
import { closeHostWindow } from "./close-host.js";

const els = {
  templateSelect: document.getElementById("templateSelect"),
  refreshBtn: document.getElementById("refreshBtn"),
  printBtn: document.getElementById("printBtn"),
  closeBtn: document.getElementById("closeBtn"),
  tabResume: document.getElementById("tabResume"),
  tabCover: document.getElementById("tabCover"),
  emptyState: document.getElementById("emptyState"),
  genBanner: document.getElementById("genBanner"),
  previewFrame: document.getElementById("previewFrame"),
  jobHint: document.getElementById("jobHint")
};

let view = "resume";
let resumeData = null;
let coverText = "";
let jobMeta = {};
let generating = false;

function fillTemplates(selectedId) {
  const templates = getAllTemplates();
  els.templateSelect.innerHTML = "";
  for (const t of templates) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    els.templateSelect.appendChild(opt);
  }
  const ids = new Set(templates.map((t) => t.id));
  els.templateSelect.value = ids.has(selectedId) ? selectedId : DEFAULT_TEMPLATE_ID;
}

function blankDoc(message) {
  return `<!doctype html><html><body style="font:15px/1.5 Outfit,Segoe UI,sans-serif;color:#5b6b86;padding:32px">${message}</body></html>`;
}

function render() {
  if (els.genBanner) {
    els.genBanner.hidden = !generating;
  }
  if (view === "cover") {
    els.tabCover.classList.add("is-active");
    els.tabResume.classList.remove("is-active");
    if (!String(coverText || "").trim()) {
      els.emptyState.hidden = false;
      els.emptyState.textContent =
        'No cover letter yet. Generate with "generate only resume" turned off.';
      els.previewFrame.srcdoc = blankDoc("No cover letter generated for this job.");
      return;
    }
    els.emptyState.hidden = true;
    els.previewFrame.srcdoc = buildCoverLetterHtml(coverText, {
      name: resumeData?.name,
      headline: resumeData?.headline,
      location: resumeData?.location,
      email: resumeData?.email,
      phone: resumeData?.phone,
      linkedin: resumeData?.linkedin
    });
    return;
  }

  els.tabResume.classList.add("is-active");
  els.tabCover.classList.remove("is-active");
  if (!resumeData || typeof resumeData !== "object") {
    els.emptyState.hidden = false;
    els.emptyState.textContent = "No resume yet. Generate from the extension panel, then refresh.";
    els.previewFrame.srcdoc = blankDoc("Nothing to preview yet.");
    return;
  }
  els.emptyState.hidden = true;
  els.previewFrame.srcdoc = resumeJsonToHtml(resumeData, els.templateSelect.value);
}

async function load() {
  const stored = await chrome.storage.local.get([
    "last_resume_json",
    "last_cover_letter_response",
    "selected_template_id",
    "last_job_title",
    "last_company_name",
    "generation_running"
  ]);
  generating = Boolean(stored.generation_running);
  resumeData = stored.last_resume_json && typeof stored.last_resume_json === "object"
    ? stored.last_resume_json
    : null;
  coverText = String(stored.last_cover_letter_response || "");
  jobMeta = {
    jobTitle: stored.last_job_title || "",
    companyName: stored.last_company_name || ""
  };
  const hintParts = [jobMeta.jobTitle, jobMeta.companyName].filter(Boolean);
  els.jobHint.textContent = hintParts.length
    ? hintParts.join(" · ")
    : "Switch templates to compare layouts without regenerating.";
  fillTemplates(stored.selected_template_id || DEFAULT_TEMPLATE_ID);
  render();
}

els.tabResume.addEventListener("click", () => {
  view = "resume";
  render();
});
els.tabCover.addEventListener("click", () => {
  view = "cover";
  render();
});
els.templateSelect.addEventListener("change", () => {
  chrome.storage.local.set({ selected_template_id: els.templateSelect.value }).catch(() => {});
  render();
});
els.refreshBtn.addEventListener("click", () => {
  load().catch(() => {});
});
els.printBtn.addEventListener("click", () => {
  els.previewFrame.contentWindow?.print();
});
els.closeBtn.addEventListener("click", () => closeHostWindow());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.last_resume_json ||
    changes.last_cover_letter_response ||
    changes.selected_template_id ||
    changes.last_job_title ||
    changes.last_company_name ||
    changes.generation_running
  ) {
    load().catch(() => {});
  }
});

load().catch((err) => {
  els.emptyState.hidden = false;
  els.emptyState.textContent = String(err?.message || err);
});
