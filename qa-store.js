/**
 * Local Q&A bank backed by IndexedDB (shared by the popup page and the service
 * worker, since extension pages and the SW share one IndexedDB origin).
 *
 * Stores previously answered application questions per profile so future
 * applications reuse a real, human-approved answer instead of re-asking the AI.
 * New AI answers are written back here, building the bank over time.
 */

export const QA_FIELD_TYPES = [
  { value: "text", label: "Text field" },
  { value: "textarea", label: "Text area (long text)" },
  { value: "select", label: "Dropdown / select" },
  { value: "combobox", label: "Combobox / searchable list" },
  { value: "checkbox", label: "Checkbox" },
  { value: "radio", label: "Radio buttons" }
];

export function normalizeFieldType(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "choice") return "select";
  if (QA_FIELD_TYPES.some((t) => t.value === v)) return v;
  return "text";
}

export function fieldTypeLabel(value) {
  const v = normalizeFieldType(value);
  return QA_FIELD_TYPES.find((t) => t.value === v)?.label || "Text field";
}

export function isChoiceFieldType(value) {
  return ["select", "combobox", "checkbox", "radio"].includes(normalizeFieldType(value));
}

const DB_NAME = "resume_bot_qa";
const DB_VERSION = 1;
const STORE = "qa_bank";

const STOPWORDS = new Set([
  "the", "and", "for", "are", "you", "your", "our", "with", "this", "that",
  "have", "has", "will", "would", "can", "could", "please", "any", "all",
  "was", "were", "did", "does", "about", "into", "from", "what", "which",
  "who", "whom", "how", "why", "when", "where", "a", "an", "of", "to", "in",
  "on", "or", "is", "it", "be", "do", "we", "us", "if", "at", "as", "by"
]);

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("byProfile", "profileId", { unique: false });
        store.createIndex("byProfileNorm", ["profileId", "questionNorm"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open Q&A database."));
  });
  return dbPromise;
}

function txStore(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Normalize question text to a stable comparison key. */
export function normalizeQuestion(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/\(required\)|\*|:/g, " ")
    .replace(/^\s*\d+[.)]\s*/, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(norm) {
  return norm.split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function bigrams(s) {
  const clean = s.replace(/\s+/g, "");
  const out = [];
  for (let i = 0; i < clean.length - 1; i += 1) out.push(clean.slice(i, i + 2));
  return out;
}

function diceCoefficient(aNorm, bNorm) {
  const a = bigrams(aNorm);
  const b = bigrams(bNorm);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const g of a) counts.set(g, (counts.get(g) || 0) + 1);
  let matches = 0;
  for (const g of b) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      counts.set(g, c - 1);
      matches += 1;
    }
  }
  return (2 * matches) / (a.length + b.length);
}

/** 0..1 similarity between two normalized question strings. */
export function questionSimilarity(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  const jt = jaccard(tokenize(aNorm), tokenize(bNorm));
  const dc = diceCoefficient(aNorm, bNorm);
  return Math.max(jt, jt * 0.6 + dc * 0.4);
}

async function getRecordsForProfiles(profileIds) {
  const db = await openDb();
  const store = txStore(db, "readonly");
  const index = store.index("byProfile");
  const results = [];
  for (const pid of profileIds) {
    const rows = await reqToPromise(index.getAll(IDBKeyRange.only(pid))).catch(() => []);
    if (Array.isArray(rows)) results.push(...rows);
  }
  return results;
}

/**
 * Find the best stored answer for a question. Searches the given profile first,
 * then the shared/global bank (profileId ""). Returns null when nothing clears
 * the similarity threshold.
 * @returns {Promise<{ record: object, score: number, exact: boolean } | null>}
 */
export async function findQaMatch(profileId, question, { threshold = 0.82 } = {}) {
  const norm = normalizeQuestion(question);
  if (!norm) return null;

  const profiles = profileId ? [profileId, ""] : [""];
  const records = await getRecordsForProfiles([...new Set(profiles)]);
  if (!records.length) return null;

  let best = null;
  for (const rec of records) {
    if (!rec || !rec.answer) continue;
    const recNorm = rec.questionNorm || normalizeQuestion(rec.question);
    const score = questionSimilarity(norm, recNorm);
    if (!best || score > best.score) best = { record: rec, score, exact: recNorm === norm };
  }

  if (best && best.score >= threshold) return best;
  return null;
}

/** Every record for a profile plus the shared bank (profileId ""). */
export async function getQaForProfileAndShared(profileId = "") {
  const ids = profileId ? [profileId, ""] : [""];
  return getRecordsForProfiles([...new Set(ids)]);
}

/**
 * The closest stored answers for many questions in one read. The form planner
 * asks about a whole page at once, so the bank is loaded a single time and
 * every field is scored against it.
 * @param {Array<{ id: string, text: string }>} questions
 * @returns {Promise<Map<string, Array<{ record: object, score: number }>>>}
 */
export async function findQaMatchesBatch(
  profileId,
  questions = [],
  { limit = 3, threshold = 0.5 } = {}
) {
  const out = new Map();
  const list = (questions || []).filter((q) => q?.id && normalizeQuestion(q.text));
  if (!list.length) return out;
  const records = (await getQaForProfileAndShared(profileId)).filter((r) => r?.answer);
  if (!records.length) return out;
  const normed = records.map((rec) => ({
    rec,
    norm: rec.questionNorm || normalizeQuestion(rec.question)
  }));

  for (const q of list) {
    const norm = normalizeQuestion(q.text);
    const scored = [];
    for (const { rec, norm: recNorm } of normed) {
      const score = questionSimilarity(norm, recNorm);
      if (score >= threshold) scored.push({ record: rec, score });
    }
    if (!scored.length) continue;
    // Equal scores: the profile's own answer beats the shared bank, newer beats older.
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(Boolean(b.record.profileId)) - Number(Boolean(a.record.profileId)) ||
        Number(b.record.updatedAt || 0) - Number(a.record.updatedAt || 0)
    );
    out.set(q.id, scored.slice(0, limit));
  }
  return out;
}

/**
 * Insert or update a Q&A. When a matching normalized question already exists for
 * the same profile, its answer is refreshed instead of duplicated.
 */
function notifyQaChanged() {
  try {
    chrome.storage?.local?.set({ qa_bank_version: Date.now() });
  } catch {
    /* not in an extension page */
  }
}

export async function saveQa({
  profileId = "",
  question,
  answer,
  fieldType = "text",
  source = "ai",
  site = "",
  silent = false
}) {
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  if (!q || !a) return null;

  const questionNorm = normalizeQuestion(q);
  const db = await openDb();
  const now = Date.now();

  const store = txStore(db, "readwrite");
  const index = store.index("byProfileNorm");
  const existing = await reqToPromise(
    index.get(IDBKeyRange.only([profileId, questionNorm]))
  ).catch(() => null);

  const record = existing
    ? {
        ...existing,
        answer: a,
        fieldType: normalizeFieldType(fieldType || existing.fieldType || "text"),
        source,
        site: site || existing.site || "",
        updatedAt: now
      }
    : {
        id:
          (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) ||
          `qa_${now}_${Math.random().toString(36).slice(2, 9)}`,
        profileId,
        question: q,
        questionNorm,
        answer: a,
        fieldType: normalizeFieldType(fieldType || "text"),
        source,
        site: site || "",
        timesUsed: 0,
        createdAt: now,
        updatedAt: now
      };

  await reqToPromise(store.put(record));
  if (!silent) notifyQaChanged();
  return record;
}

export async function recordQaUsage(id) {
  if (!id) return;
  const db = await openDb();
  const store = txStore(db, "readwrite");
  const rec = await reqToPromise(store.get(id)).catch(() => null);
  if (!rec) return;
  rec.timesUsed = Number(rec.timesUsed || 0) + 1;
  rec.lastUsedAt = Date.now();
  await reqToPromise(store.put(rec)).catch(() => {});
}

export async function getAllQa(profileId = null) {
  const db = await openDb();
  const store = txStore(db, "readonly");
  const all = await reqToPromise(store.getAll()).catch(() => []);
  const rows = Array.isArray(all) ? all : [];
  const filtered =
    profileId == null ? rows : rows.filter((r) => r.profileId === profileId);
  return filtered.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function getQaById(id) {
  if (!id) return null;
  const db = await openDb();
  return (await reqToPromise(txStore(db, "readonly").get(id)).catch(() => null)) || null;
}

export async function getQaCount(profileId = null) {
  const rows = await getAllQa(profileId);
  return rows.length;
}

export async function deleteQa(id) {
  if (!id) return;
  const db = await openDb();
  await reqToPromise(txStore(db, "readwrite").delete(id)).catch(() => {});
  notifyQaChanged();
}

export async function clearQa(profileId = null) {
  const db = await openDb();
  if (profileId == null) {
    await reqToPromise(txStore(db, "readwrite").clear()).catch(() => {});
    notifyQaChanged();
    return;
  }
  const rows = await getAllQa(profileId);
  const store = txStore(db, "readwrite");
  for (const r of rows) store.delete(r.id);
  notifyQaChanged();
}

export async function exportQa(profileId = null) {
  const rows = await getAllQa(profileId);
  return rows.map((r) => ({
    profileId: r.profileId || "",
    question: r.question,
    answer: r.answer,
    fieldType: normalizeFieldType(r.fieldType || "text"),
    source: r.source || "user",
    site: r.site || "",
    timesUsed: Number(r.timesUsed || 0)
  }));
}

export async function importQa(records) {
  const list = Array.isArray(records) ? records : [];
  let imported = 0;
  for (const rec of list) {
    const saved = await saveQa({
      profileId: rec.profileId || "",
      question: rec.question,
      answer: rec.answer,
      fieldType: rec.fieldType || "text",
      source: rec.source || "user",
      site: rec.site || "",
      silent: true
    });
    if (saved) imported += 1;
  }
  if (imported) notifyQaChanged();
  return imported;
}
