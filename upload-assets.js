/**
 * Last generated resume / cover letter PDFs for application form uploads.
 * Stored in IndexedDB so Autofill can inject them into <input type="file">.
 *
 * Also keeps a per-job cache so Apply can reuse a batch-built resume later.
 */

const DB_NAME = "resume-bot-uploads";
const DB_VERSION = 1;
const STORE = "docs";
const LAST_DOCS_KEY = "last_generated_docs";
const JOB_DOCS_PREFIX = "job_docs:";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

function idbGet(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbSet(key, value) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbDelete(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function normalizeDocsPayload(docs = {}) {
  return {
    resume: docs?.resume || null,
    coverLetter: docs?.coverLetter || null,
    folderName: docs?.folderName || "",
    pathLabel: docs?.pathLabel || "",
    importedJobId: docs?.importedJobId || "",
    answerContext:
      docs?.answerContext && typeof docs.answerContext === "object" ? docs.answerContext : null,
    updatedAt: Date.now()
  };
}

async function publishLastDocsMeta(payload) {
  await chrome.storage.local.set({
    last_upload_docs_ready: true,
    last_upload_docs_meta: {
      hasResume: Boolean(payload.resume?.base64),
      hasCoverLetter: Boolean(payload.coverLetter?.base64),
      resumeName: payload.resume?.fileName || "",
      coverLetterName: payload.coverLetter?.fileName || "",
      folderName: payload.folderName || "",
      pathLabel: payload.pathLabel || "",
      importedJobId: payload.importedJobId || "",
      updatedAt: payload.updatedAt
    }
  });
}

/**
 * @param {{ resume?: { fileName: string, mimeType: string, base64: string }, coverLetter?: { fileName: string, mimeType: string, base64: string }, folderName?: string, importedJobId?: string }} docs
 */
export async function setLastGeneratedDocs(docs) {
  const payload = normalizeDocsPayload(docs);
  await idbSet(LAST_DOCS_KEY, payload);
  await publishLastDocsMeta(payload);
  return payload;
}

export async function getLastGeneratedDocs() {
  return (await idbGet(LAST_DOCS_KEY)) || null;
}

/** Persist PDFs for a specific imported job id (batch resume → later Apply). */
export async function setGeneratedDocsForJob(jobId, docs) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const payload = normalizeDocsPayload({ ...docs, importedJobId: id });
  await idbSet(`${JOB_DOCS_PREFIX}${id}`, payload);
  await setLastGeneratedDocs(payload);
  return payload;
}

export async function getGeneratedDocsForJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  return (await idbGet(`${JOB_DOCS_PREFIX}${id}`)) || null;
}

/** Make a job's cached PDFs the active upload set for Autofill / Auto Apply. */
export async function activateGeneratedDocsForJob(jobId) {
  const docs = await getGeneratedDocsForJob(jobId);
  if (!docs?.resume?.base64 && !docs?.coverLetter?.base64) return null;
  await setLastGeneratedDocs(docs);
  return docs;
}

export async function clearGeneratedDocsForJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return;
  await idbDelete(`${JOB_DOCS_PREFIX}${id}`).catch(() => {});
}

/** Extract resume + cover letter entries from a generated file bundle. */
export function pickUploadDocsFromBundle(folderName, files = []) {
  let resume = null;
  let coverLetter = null;
  const otherPdfs = [];

  for (const file of files) {
    if (!file || file.encoding !== "base64") continue;
    const name = String(file.name || "");
    const lower = name.toLowerCase();
    const mimeType = file.mimeType || "application/pdf";
    const entry = { fileName: name, mimeType, base64: file.content };

    if (/cover.?letter/i.test(lower)) {
      coverLetter = entry;
      continue;
    }
    if (/_resume\.pdf$/i.test(lower) || /resume/i.test(lower) || /(^|[^a-z])cv([^a-z]|$)/i.test(lower)) {
      resume = entry;
      continue;
    }
    if (!lower.endsWith(".pdf")) continue;
    otherPdfs.push(entry);
  }

  // A custom filename with no "resume" in it is still the resume when it is the
  // only other PDF. Several unnamed PDFs are not guessed — that uploaded the
  // wrong document.
  if (!resume && otherPdfs.length === 1) resume = otherPdfs[0];

  return { folderName: folderName || "", resume, coverLetter };
}
