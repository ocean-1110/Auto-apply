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
/** User-entered absolute path to the selected output folder (FS Access API cannot expose this). */
const OUTPUT_DIR_ABS_PATH_KEY = "output_directory_absolute_path";
const LAST_SAVE_META_KEY = "last_save_meta";

/** In-memory handle after a successful unlock this page lifetime (avoids stale IDB reads). */
let sessionOutputHandle = null;

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
  sessionOutputHandle = handle;
  await idbSet(HANDLE_STORE, HANDLE_KEY, handle);
  const name = handle.name || "Selected folder";
  await chrome.storage.local.set({ [OUTPUT_DIR_NAME_KEY]: name });
  return name;
}

export async function getOutputDirectoryHandle() {
  if (sessionOutputHandle) return sessionOutputHandle;
  const handle = await idbGet(HANDLE_STORE, HANDLE_KEY);
  if (handle) sessionOutputHandle = handle;
  return handle || null;
}

export async function getOutputDirectoryName() {
  const data = await chrome.storage.local.get(OUTPUT_DIR_NAME_KEY);
  return data[OUTPUT_DIR_NAME_KEY] || "";
}

/** Normalize a Windows/Unix absolute folder path for storage / clipboard. */
export function normalizeAbsoluteDirectoryPath(raw) {
  let path = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!path) return "";

  // Browser / Explorer "Copy as path" sometimes yields file URLs.
  path = path.replace(/^file:\/\/\/?/i, "");
  // file:///D:/foo → D:/foo ; keep UNC shares (\\server\share).
  if (/^[A-Za-z]\|/.test(path)) {
    path = path.replace(/^([A-Za-z])\|/, "$1:");
  }

  // Drive letter without separator (D:Bid\...) → D:\Bid\...
  if (/^[A-Za-z]:[^\\/]/.test(path)) {
    path = path.replace(/^([A-Za-z]:)/, "$1\\");
  }

  // Prefer Windows backslashes when a drive letter or UNC path is present.
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    path = path.replace(/\//g, "\\");
    // Collapse duplicate separators (user typed D:\\Bid\\... or mixed //).
    if (path.startsWith("\\\\")) {
      // UNC: keep the leading \\, collapse the rest.
      path = `\\\\${path.slice(2).replace(/\\{2,}/g, "\\")}`;
    } else {
      path = path.replace(/\\{2,}/g, "\\");
    }
  }

  // Strip trailing separators (Explorer is happier without a final \).
  path = path.replace(/[\\/]+$/, "");
  // Windows forbids trailing dots/spaces on the final segment.
  path = path.replace(/[. ]+$/g, "");
  return path;
}

export async function getOutputDirectoryAbsolutePath() {
  const data = await chrome.storage.local.get(OUTPUT_DIR_ABS_PATH_KEY);
  return normalizeAbsoluteDirectoryPath(data[OUTPUT_DIR_ABS_PATH_KEY] || "");
}

export async function setOutputDirectoryAbsolutePath(absolutePath) {
  const path = normalizeAbsoluteDirectoryPath(absolutePath);
  if (!path) {
    await chrome.storage.local.remove(OUTPUT_DIR_ABS_PATH_KEY);
    return "";
  }
  await chrome.storage.local.set({ [OUTPUT_DIR_ABS_PATH_KEY]: path });
  return path;
}

/**
 * Join absolute output-folder path with a job subfolder name for clipboard / Explorer.
 * Falls back to relative "root / job" when absolute path is not configured.
 */
export async function buildResumeFolderAbsolutePath(jobFolderName) {
  const folder = sanitizeJobFolderName(jobFolderName);
  if (!folder || folder === "untitled") return "";
  const absRoot = await getOutputDirectoryAbsolutePath();
  if (absRoot) {
    const root = normalizeAbsoluteDirectoryPath(absRoot);
    const rootTail = root.split(/[/\\]/).filter(Boolean).pop() || "";
    if (rootTail.toLowerCase() === folder.toLowerCase()) return root;
    // Always join with a single Windows separator for Explorer paste.
    return normalizeAbsoluteDirectoryPath(`${root}\\${folder}`);
  }
  const rootName = (await getOutputDirectoryName()) || "";
  return rootName ? `${rootName} / ${folder}` : folder;
}

export async function clearOutputDirectoryHandle() {
  sessionOutputHandle = null;
  await idbDelete(HANDLE_STORE, HANDLE_KEY);
  await chrome.storage.local.remove([OUTPUT_DIR_NAME_KEY, OUTPUT_DIR_ABS_PATH_KEY]);
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
 * queryPermission can still say "granted" after Chrome silently revoked access
 * (common when the extension panel was backgrounded during a long generate).
 * Prove we can actually read the directory.
 */
export async function probeDirectoryAccess(handle) {
  if (!handle) return false;
  try {
    for await (const _entry of handle.entries()) {
      break;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Chrome only allows requestPermission() while a user gesture is active, so the
 * prompt is limited to call paths that started from a real click or key press.
 * Background flushes just report back that a gesture is still needed.
 *
 * Chrome may also revoke a prior grant while this tab is backgrounded for a long
 * OpenAI/PDF run — unlock again with one click (prefer "Allow on every visit").
 */
export async function ensureDirectoryPermission(handle, { interactive = false } = {}) {
  if (!handle) return false;
  const state = await queryDirectoryPermission(handle);
  if (state === "granted") {
    if (await probeDirectoryAccess(handle)) {
      sessionOutputHandle = handle;
      return true;
    }
    // Stale "granted" — fall through and re-request if we still have a gesture.
  }
  if (!interactive || !hasUserActivation()) return false;
  try {
    const next = await handle.requestPermission({ mode: "readwrite" });
    if (next === "granted" && (await probeDirectoryAccess(handle))) {
      sessionOutputHandle = handle;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Unlock the saved output folder while a user click is still a user gesture.
 * Call this as the FIRST await on Generate / Save / Batch — before any other
 * async work — so Chrome still sees the click as user activation.
 *
 * @returns {Promise<{ ok: boolean, status: "granted"|"prompt"|"missing"|"denied", error?: string }>}
 */
export async function unlockOutputDirectory({ interactive = true } = {}) {
  const handle = await getOutputDirectoryHandle();
  if (!handle) {
    return {
      ok: false,
      status: "missing",
      error: 'No output folder selected. Click "Select folder" first.'
    };
  }
  if (await ensureDirectoryPermission(handle, { interactive: false })) {
    return { ok: true, status: "granted" };
  }
  if (!interactive) {
    const before = await queryDirectoryPermission(handle);
    return {
      ok: false,
      status: before === "denied" ? "denied" : "prompt",
      error: "Chrome needs one click in the extension panel to unlock the output folder."
    };
  }
  const granted = await ensureDirectoryPermission(handle, { interactive: true });
  if (granted) return { ok: true, status: "granted" };
  return {
    ok: false,
    status: (await queryDirectoryPermission(handle)) === "denied" ? "denied" : "prompt",
    error:
      "Folder access was not granted. Click Unlock and choose Allow on every visit if Chrome offers that option."
  };
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
      .replace(/[. ]+$/g, "")
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
    let resumeModified = -1;
    let coverModified = -1;
    const otherPdfs = [];

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
      const modified = Number(file.lastModified) || 0;

      if (/cover.?letter/i.test(lower)) {
        if (!coverLetter || modified >= coverModified) {
          coverLetter = entry;
          coverModified = modified;
        }
        continue;
      }
      if (/_resume\.pdf$/i.test(lower) || /resume/i.test(lower) || /(^|[^a-z])cv([^a-z]|$)/i.test(lower)) {
        // An older resume left in the same folder must not win over the latest one.
        if (!resume || modified >= resumeModified) {
          resume = entry;
          resumeModified = modified;
        }
        continue;
      }
      otherPdfs.push({ ...entry, modified });
    }
    otherPdfs.sort((a, b) => (b.modified || 0) - (a.modified || 0));

  if (!resume && otherPdfs.length === 1) resume = otherPdfs[0];

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
