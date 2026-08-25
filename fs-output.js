/**
 * User-selected output directory (File System Access API) + pending file writes.
 * Directory handles are stored in IndexedDB; the panel page performs the actual writes.
 */

const DB_NAME = "resume-bot-fs";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const PENDING_STORE = "pending";
const HANDLE_KEY = "output_directory";
const LAST_JOB_DIR_KEY = "last_job_directory";
const PENDING_KEY = "pending_output_files";
const OUTPUT_DIR_NAME_KEY = "output_directory_name";
const LAST_SAVE_META_KEY = "last_save_meta";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

function idbGet(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbSet(storeName, key, value) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbDelete(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

export async function saveOutputDirectoryHandle(handle) {
  if (!handle) throw new Error("Directory handle is required.");
  await idbSet(HANDLE_STORE, HANDLE_KEY, handle);
  const name = handle.name || "Selected folder";
  await chrome.storage.local.set({ [OUTPUT_DIR_NAME_KEY]: name });
  return name;
}

export async function getOutputDirectoryHandle() {
  const handle = await idbGet(HANDLE_STORE, HANDLE_KEY);
  return handle || null;
}

export async function getOutputDirectoryName() {
  const data = await chrome.storage.local.get(OUTPUT_DIR_NAME_KEY);
  return data[OUTPUT_DIR_NAME_KEY] || "";
}

export async function clearOutputDirectoryHandle() {
  await idbDelete(HANDLE_STORE, HANDLE_KEY);
  await chrome.storage.local.remove(OUTPUT_DIR_NAME_KEY);
}

function hasUserActivation() {
  try {
    return Boolean(navigator.userActivation?.isActive);
  } catch {
    return false;
  }
}

export async function queryDirectoryPermission(handle) {
  if (!handle) return "denied";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

/**
 * Chrome only allows requestPermission() while a user gesture is active, so the
 * prompt is limited to call paths that started from a real click or key press.
 * Background flushes just report back that a gesture is still needed.
 */
export async function ensureDirectoryPermission(handle, { interactive = false } = {}) {
  if (!handle) return false;
  if ((await queryDirectoryPermission(handle)) === "granted") return true;
  if (!interactive || !hasUserActivation()) return false;
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/**
 * @param {{ folderName: string, files: Array<{ name: string, mimeType?: string, encoding: "utf8"|"base64", content: string }> }} payload
 */
export async function setPendingOutputFiles(payload) {
  await idbSet(PENDING_STORE, PENDING_KEY, {
    ...payload,
    createdAt: Date.now()
  });
  await chrome.storage.local.set({
    pending_fs_write: true,
    pending_fs_folder: payload.folderName || ""
  });
}

export async function getPendingOutputFiles() {
  return (await idbGet(PENDING_STORE, PENDING_KEY)) || null;
}

export async function clearPendingOutputFiles() {
  await idbDelete(PENDING_STORE, PENDING_KEY);
  await chrome.storage.local.remove(["pending_fs_write", "pending_fs_folder"]);
}

function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function sanitizeJobFolderName(folderName) {
  return (
    String(folderName || "untitled")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "untitled"
  );
}

/**
 * Read resume + cover letter PDFs from a previously saved job subfolder
 * under the user's output directory (for Apply after batch generation).
 */
export async function readJobUploadDocsFromDirectory(folderName, { interactive = false } = {}) {
  const safeFolder = sanitizeJobFolderName(folderName);
  if (!safeFolder || safeFolder === "untitled") return null;

  const root = await getOutputDirectoryHandle();
  if (!root) return null;

  const allowed = await ensureDirectoryPermission(root, { interactive });
  if (!allowed) {
    const err = new Error(
      "Chrome needs one click in the extension panel to unlock the output folder."
    );
    err.code = "NEEDS_PERMISSION";
    throw err;
  }

  let jobDir;
  try {
    jobDir = await root.getDirectoryHandle(safeFolder, { create: false });
  } catch {
    return null;
  }

  let resume = null;
  let coverLetter = null;

  for await (const [name, handle] of jobDir.entries()) {
    if (!handle || handle.kind !== "file") continue;
    const lower = String(name || "").toLowerCase();
    if (!lower.endsWith(".pdf")) continue;

    const file = await handle.getFile();
    const buffer = new Uint8Array(await file.arrayBuffer());
    const entry = {
      fileName: name,
      mimeType: file.type || "application/pdf",
      base64: uint8ArrayToBase64(buffer)
    };

    if (/cover.?letter/i.test(lower)) {
      coverLetter = entry;
      continue;
    }
    if (/_resume\.pdf$/i.test(lower) || /resume/i.test(lower)) {
      resume = entry;
      continue;
    }
    if (!resume) resume = entry;
  }

  if (!resume?.base64 && !coverLetter?.base64) return null;
  return { folderName: safeFolder, resume, coverLetter };
}

/**
 * Write a job subfolder into the user-selected root directory.
 * Creates the folder if it does not exist.
 */
export async function writeJobFilesToDirectory(
  rootHandle,
  folderName,
  files,
  { interactive = false } = {}
) {
  if (!rootHandle) throw new Error("No output folder selected.");
  const allowed = await ensureDirectoryPermission(rootHandle, { interactive });
  if (!allowed) {
    const err = new Error(
      "Chrome needs one click in the extension panel to unlock the output folder."
    );
    err.code = "NEEDS_PERMISSION";
    throw err;
  }

  const safeFolder = sanitizeJobFolderName(folderName);

  const jobDir = await rootHandle.getDirectoryHandle(safeFolder, { create: true });

  for (const file of files || []) {
    const fileName = String(file.name || "file")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .trim();
    if (!fileName) continue;

    const handle = await jobDir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      if (file.encoding === "base64") {
        await writable.write(base64ToUint8Array(file.content));
      } else {
        await writable.write(String(file.content ?? ""));
      }
    } finally {
      await writable.close();
    }
  }

  // Remember job folder so "Open folder" can jump back here.
  await idbSet(HANDLE_STORE, LAST_JOB_DIR_KEY, jobDir);

  return { folderName: safeFolder, rootName: rootHandle.name || "", method: "fs" };
}

export async function getLastJobDirectoryHandle() {
  return (await idbGet(HANDLE_STORE, LAST_JOB_DIR_KEY)) || null;
}

/**
 * Open the folder where the resume / cover letter were saved.
 *
 * The File System Access API cannot reveal a folder in the OS file manager, and
 * it must NOT re-download the files (that would trigger a Save-As prompt when
 * Chrome is set to "Ask where to save each file"). Instead we open a native
 * picker rooted at the exact saved directory so the generated files are right
 * there, and open whatever the user selects — no downloads, no save prompts.
 */
export async function browseLastSavedJobDirectory(preferredFolderName = "") {
  let jobDir = null;
  const wanted = sanitizeJobFolderName(preferredFolderName || "");
  if (wanted) {
    const root = await getOutputDirectoryHandle();
    if (root) {
      const allowed = await ensureDirectoryPermission(root, { interactive: true });
      if (allowed) {
        try {
          jobDir = await root.getDirectoryHandle(wanted, { create: false });
        } catch {
          jobDir = null;
        }
      }
    }
  }
  if (!jobDir) jobDir = await getLastJobDirectoryHandle();
  if (!jobDir) {
    throw new Error("No saved job folder is available yet.");
  }
  // Always reached from a click on "Open folder", so prompting is allowed here.
  const allowed = await ensureDirectoryPermission(jobDir, { interactive: true });
  if (!allowed) {
    throw new Error("Permission denied. Select your output folder again.");
  }

  const folderName =
    String(jobDir.name || "resume-bot")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "resume-bot";

  const isAbort = (err) =>
    err && (err.name === "AbortError" || String(err.message || "").includes("abort"));

  // Preferred: open-file dialog inside the saved folder (shows resume + cover letter).
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        startIn: jobDir,
        types: [
          {
            description: "Generated documents",
            accept: {
              "application/pdf": [".pdf"],
              "text/html": [".html"],
              "text/plain": [".txt"]
            }
          }
        ]
      });

      // Open any files the user picked, so the resume/cover letter actually open.
      const opened = [];
      for (const handle of handles || []) {
        try {
          const file = await handle.getFile();
          const url = URL.createObjectURL(file);
          window.open(url, "_blank");
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          opened.push(file.name);
        } catch {
          /* ignore a single file that fails to open */
        }
      }
      return { ok: true, method: "file-picker", folderName, files: opened };
    } catch (err) {
      if (isAbort(err)) return { ok: true, method: "file-picker", aborted: true, folderName };
      throw err;
    }
  }

  // Fallback: directory dialog rooted at the saved folder.
  if (typeof window.showDirectoryPicker === "function") {
    try {
      await window.showDirectoryPicker({ startIn: jobDir });
      return { ok: true, method: "directory-picker", folderName };
    } catch (err) {
      if (isAbort(err)) return { ok: true, method: "directory-picker", aborted: true, folderName };
      throw err;
    }
  }

  throw new Error(
    "This browser can't open the folder directly. Your files are in the output folder you selected."
  );
}

export async function setLastSaveMeta(meta, { announce = true } = {}) {
  const payload = {
    [LAST_SAVE_META_KEY]: {
      ...meta,
      at: Date.now()
    }
  };
  if (announce) payload.last_save_ready = true;
  await chrome.storage.local.set(payload);
}

export async function getLastSaveMeta() {
  const data = await chrome.storage.local.get(LAST_SAVE_META_KEY);
  return data[LAST_SAVE_META_KEY] || null;
}

/**
 * Flush any pending generation output into the selected directory.
 * Must run in a window context (panel/popup), not the service worker.
 */
export async function flushPendingOutputToSelectedDirectory({ interactive = false } = {}) {
  const pending = await getPendingOutputFiles();
  if (!pending?.files?.length) {
    return { ok: false, skipped: true, error: "No pending files to save." };
  }

  const root = await getOutputDirectoryHandle();
  if (!root) {
    return {
      ok: false,
      skipped: true,
      error: "No output folder selected. Click Select folder first."
    };
  }

  let result;
  try {
    result = await writeJobFilesToDirectory(root, pending.folderName, pending.files, {
      interactive
    });
  } catch (err) {
    if (err?.code === "NEEDS_PERMISSION") {
      // Files stay in IndexedDB, so nothing is lost while we wait for a click.
      return {
        ok: false,
        needsPermission: true,
        folderName: pending.folderName || "",
        error: String(err.message || err)
      };
    }
    throw err;
  }
  await clearPendingOutputFiles();
  const pathLabel = `${result.rootName}/${result.folderName}`;
  await setLastSaveMeta({
    pathLabel,
    method: "fs",
    folderName: result.folderName,
    downloadId: null
  });
  return {
    ok: true,
    pathLabel,
    method: "fs",
    ...result
  };
}
