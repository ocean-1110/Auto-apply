/**
 * Last generated resume / cover letter PDFs for application form uploads.
 * Stored in IndexedDB so Autofill can inject them into <input type="file">.
 */

const DB_NAME = "resume-bot-uploads";
const DB_VERSION = 1;
const STORE = "docs";
const LAST_DOCS_KEY = "last_generated_docs";

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

/**
 * @param {{ resume?: { fileName: string, mimeType: string, base64: string }, coverLetter?: { fileName: string, mimeType: string, base64: string }, folderName?: string }} docs
 */
export async function setLastGeneratedDocs(docs) {
  const payload = {
    resume: docs?.resume || null,
    coverLetter: docs?.coverLetter || null,
    folderName: docs?.folderName || "",
    updatedAt: Date.now()
  };
  await idbSet(LAST_DOCS_KEY, payload);
  await chrome.storage.local.set({
    last_upload_docs_ready: true,
    last_upload_docs_meta: {
      hasResume: Boolean(payload.resume?.base64),
      hasCoverLetter: Boolean(payload.coverLetter?.base64),
      resumeName: payload.resume?.fileName || "",
      coverLetterName: payload.coverLetter?.fileName || "",
      folderName: payload.folderName || "",
      updatedAt: payload.updatedAt
    }
  });
  return payload;
}

export async function getLastGeneratedDocs() {
  return (await idbGet(LAST_DOCS_KEY)) || null;
}

/** Extract resume + cover letter entries from a generated file bundle. */
export function pickUploadDocsFromBundle(folderName, files = []) {
  let resume = null;
  let coverLetter = null;

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
    if (/_resume\.pdf$/i.test(lower) || (/resume/i.test(lower) && lower.endsWith(".pdf"))) {
      resume = entry;
      continue;
    }
    if (!resume && lower.endsWith(".pdf")) {
      resume = entry;
    }
  }

  return { folderName: folderName || "", resume, coverLetter };
}
