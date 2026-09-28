/**
 * Resume-writing models. Form autofill stays on OPENAI_FORM_MODEL.
 * The popup and preview pickers share chrome.storage.local.
 */

import { getEnv } from "./env.js";

export const RESUME_MODEL_KEY = "openai_resume_model";

/** USD per 1M tokens, standard API rate (input / output). */
export const RESUME_MODELS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    input: 4,
    output: 20,
    blurb: "Flagship. Strongest wording and judgment. Slowest. Use when the resume has to be the best."
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    input: 2,
    output: 12,
    blurb: "Balanced intelligence and cost. Close to Sol for everyday resumes."
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    input: 0.2,
    output: 1.2,
    blurb: "Fastest and cheapest 5.6 model. Best for drafts and batches. Weaker on subtle wording."
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    input: 5,
    output: 30,
    blurb: "Previous flagship. Very strong writing. Costs more than Sol."
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    input: 2.5,
    output: 15,
    blurb: "Earlier generation. Solid quality. Use if 5.6 names are not on your API key."
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    input: 1.25,
    output: 10,
    blurb: "Original GPT-5. Reliable reasoning model. Older knowledge. Choose it if newer names are unavailable."
  }
];

const BY_ID = new Map(RESUME_MODELS.map((model) => [model.id, model]));

export function resumeModelById(id) {
  return BY_ID.get(String(id || "").trim()) || null;
}

function formatUsd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return n < 1 ? `$${n.toFixed(2)}` : `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}

/** Short form for the closed control: "$0.20 / $1.20" */
export function resumeModelPriceShort(model) {
  if (!model || !Number.isFinite(Number(model.input))) return "";
  return `${formatUsd(model.input)} / ${formatUsd(model.output)}`;
}

/** "In $4 · Out $20 per 1M" */
export function resumeModelPriceLabel(model) {
  if (!model || !Number.isFinite(Number(model.input))) return "";
  return `In ${formatUsd(model.input)} · Out ${formatUsd(model.output)} per 1M`;
}

export function resumeModelSummary(model) {
  if (!model) return "";
  const price = resumeModelPriceLabel(model);
  return [price, model.blurb].filter(Boolean).join(" — ");
}

export async function getSelectedResumeModelId() {
  let stored = "";
  try {
    const data = await chrome.storage.local.get(RESUME_MODEL_KEY);
    stored = String(data[RESUME_MODEL_KEY] || "").trim();
  } catch {
    stored = "";
  }
  if (resumeModelById(stored)) return stored;
  const fromEnv = String((await getEnv("OPENAI_MODEL", "")) || "").trim();
  if (resumeModelById(fromEnv)) return fromEnv;
  if (fromEnv) return fromEnv;
  return "gpt-5.6-luna";
}

export async function setSelectedResumeModelId(id) {
  const model = resumeModelById(id);
  const value = model ? model.id : String(id || "").trim();
  if (!value) return "";
  await chrome.storage.local.set({ [RESUME_MODEL_KEY]: value });
  return value;
}

/**
 * Compact picker. Each row shows a one-line explanation, and hovering the row
 * repeats it in the tooltip. Both pages share the same stored choice.
 * @param {HTMLElement | null} root
 */
export function mountResumeModelPicker(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  root.classList.add("model-picker");

  const label = document.createElement("span");
  label.className = "model-picker-label";
  label.textContent = "Model";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "model-picker-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const menu = document.createElement("ul");
  menu.className = "model-picker-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");

  let currentId = "";

  const paint = (id) => {
    currentId = id;
    const model = resumeModelById(id);
    const name = model?.label || id || "Model";
    const price = resumeModelPriceLabel(model);
    button.textContent = price ? `${name} · ${resumeModelPriceShort(model)}` : name;
    button.title = resumeModelSummary(model) || "Custom model from .env.";
    for (const item of menu.querySelectorAll("[data-model]")) {
      item.classList.toggle("is-selected", item.dataset.model === id);
      item.setAttribute("aria-selected", item.dataset.model === id ? "true" : "false");
    }
  };

  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  for (const model of RESUME_MODELS) {
    const item = document.createElement("li");
    const choice = document.createElement("button");
    choice.type = "button";
    choice.dataset.model = model.id;
    choice.title = resumeModelSummary(model);
    choice.setAttribute("role", "option");
    const name = document.createElement("strong");
    name.textContent = model.label;
    const price = document.createElement("span");
    price.className = "model-picker-price";
    price.textContent = resumeModelPriceLabel(model);
    const blurb = document.createElement("span");
    blurb.textContent = model.blurb;
    choice.append(name, price, blurb);
    choice.addEventListener("click", () => {
      paint(model.id);
      close();
      setSelectedResumeModelId(model.id).catch(() => {});
    });
    item.append(choice);
    menu.append(item);
  }

  button.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) close();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[RESUME_MODEL_KEY]) return;
    const next = String(changes[RESUME_MODEL_KEY].newValue || "").trim();
    if (next && next !== currentId) paint(next);
  });

  root.append(label, button, menu);
  getSelectedResumeModelId()
    .then((id) => paint(id))
    .catch(() => paint("gpt-5.6-luna"));
}
