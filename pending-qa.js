/**
 * Inbox of application questions that were not in the Q&A bank.
 * Autofill extracts type, question text, options, and how to answer so the
 * user can register them in the bank without re-inspecting the form.
 */

import { normalizeFieldType, normalizeQuestion } from "./qa-store.js";

const KEY = "pending_qa_drafts";
const MAX = 80;

const SENSITIVE_RE =
  /\b(password|otp|captcha|ssn|social security|credit card|card number|cvv|routing|account number|search|first name|last name|full name|middle name|legal name|email|e-mail|phone|mobile|telephone|address|street|city|state|province|zip|postal|country|linkedin|github|portfolio|website|date of birth|dob|birthday|salary|compensation|desired pay|expected pay|disability|veteran|military|\brace\b|ethnic|gender|\bsex\b|hispanic|latino|felony|conviction|criminal)\b/i;

export function answerHowForField(fieldType, options = []) {
  const type = normalizeFieldType(fieldType);
  const opts = (options || []).map((o) => String(o || "").trim()).filter(Boolean);
  const optPreview = opts.length ? `: ${opts.slice(0, 8).join(", ")}` : "";
  if (type === "checkbox") {
    const yesNo = opts.length > 0 && opts.every((o) => /^(yes|no)$/i.test(o));
    return yesNo ? "Check Yes or No" : `Check the matching option(s)${optPreview}`;
  }
  if (type === "radio") return `Select one radio option${optPreview}`;
  if (type === "select") return `Pick one dropdown option${optPreview}`;
  if (type === "combobox") return `Pick one from the searchable list${optPreview}`;
  if (type === "textarea") return "Type a longer written answer";
  return "Type a short text answer";
}

function notifyChanged() {
  try {
    chrome.storage?.local?.set({ pending_qa_version: Date.now() });
  } catch {
    /* not in an extension page */
  }
}

export async function getPendingQa(profileId = null) {
  const data = await chrome.storage.local.get(KEY);
  const rows = Array.isArray(data[KEY]) ? data[KEY] : [];
  if (profileId == null) return rows;
  return rows.filter((r) => String(r.profileId || "") === String(profileId || ""));
}

export async function getPendingQaCount(profileId = null) {
  const rows = await getPendingQa(profileId);
  return rows.length;
}

function draftFromQuestion(q = {}, { profileId = "", site = "" } = {}) {
  const question = String(q.label || q.question || "").trim();
  if (!question || SENSITIVE_RE.test(question)) return null;
  const options = Array.isArray(q.options)
    ? q.options.map((o) => String(o || "").trim()).filter(Boolean).slice(0, 40)
    : [];
  const fieldType = normalizeFieldType(q.fieldType || (options.length ? "select" : "text"));
  return {
    id: `pq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    profileId: String(profileId || "").trim(),
    question,
    questionNorm: normalizeQuestion(question),
    fieldType,
    options,
    answerHow: answerHowForField(fieldType, options),
    site: String(site || q.site || "").trim(),
    seenAt: Date.now(),
    timesSeen: 1
  };
}

export async function upsertPendingQa(questions = [], { profileId = "", site = "" } = {}) {
  const incoming = (questions || [])
    .map((q) => draftFromQuestion(q, { profileId, site }))
    .filter(Boolean);
  if (!incoming.length) return 0;

  const existing = await getPendingQa(null);
  const byKey = new Map(
    existing.map((row) => [`${row.profileId || ""}::${row.questionNorm || ""}`, row])
  );
  let added = 0;

  for (const draft of incoming) {
    const key = `${draft.profileId}::${draft.questionNorm}`;
    const prev = byKey.get(key);
    if (prev) {
      const options = [...new Set([...(prev.options || []), ...(draft.options || [])])].slice(0, 40);
      byKey.set(key, {
        ...prev,
        fieldType: draft.fieldType || prev.fieldType,
        options,
        answerHow: answerHowForField(draft.fieldType || prev.fieldType, options),
        site: draft.site || prev.site || "",
        seenAt: Date.now(),
        timesSeen: Number(prev.timesSeen || 1) + 1
      });
    } else {
      byKey.set(key, draft);
      added += 1;
    }
  }

  const next = [...byKey.values()]
    .sort((a, b) => Number(b.seenAt || 0) - Number(a.seenAt || 0))
    .slice(0, MAX);
  await chrome.storage.local.set({ [KEY]: next });
  notifyChanged();
  return added;
}

export async function dismissPendingQa(id) {
  if (!id) return;
  const rows = await getPendingQa(null);
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return;
  await chrome.storage.local.set({ [KEY]: next });
  notifyChanged();
}

export async function dismissPendingMatchingQuestion(question, profileId = "") {
  const norm = normalizeQuestion(question);
  if (!norm) return;
  const rows = await getPendingQa(null);
  const pid = String(profileId || "").trim();
  const next = rows.filter((r) => {
    if ((r.questionNorm || normalizeQuestion(r.question)) !== norm) return true;
    if (!pid) return false;
    return String(r.profileId || "") !== pid && String(r.profileId || "") !== "";
  });
  if (next.length === rows.length) return;
  await chrome.storage.local.set({ [KEY]: next });
  notifyChanged();
}

export async function getPendingQaById(id) {
  if (!id) return null;
  const rows = await getPendingQa(null);
  return rows.find((r) => r.id === id) || null;
}
