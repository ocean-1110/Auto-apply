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

export async function ensureDirectoryPermission(handle) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
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

/**
 * Write a job subfolder into the user-selected root directory.
 * Creates the folder if it does not exist.
 */
export async function writeJobFilesToDirectory(rootHandle, folderName, files) {
  if (!rootHandle) throw new Error("No output folder selected.");
  const allowed = await ensureDirectoryPermission(rootHandle);
  if (!allowed) {
    throw new Error("Permission denied for the selected output folder. Select the folder again.");
  }

  const safeFolder = String(folderName || "untitled")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "untitled";

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
 * Open the last saved job folder in the OS file manager when possible.
 *
 * Why not showDirectoryPicker?
 * That API opens Chrome's "Select folder" dialog (for picking a directory),
 * not File Explorer — so resume/cover-letter files are easy to miss.
 *
 * Fix: re-download the job files from the stored DirectoryHandle into
 * Chrome's Downloads/{jobFolder}/ (silent), then chrome.downloads.show()
 * which opens Explorer on that folder with the files visible.
 */
export async function browseLastSavedJobDirectory() {
  const jobDir = await getLastJobDirectoryHandle();
  if (!jobDir) {
    throw new Error("No saved job folder is available yet.");
  }
  const allowed = await ensureDirectoryPermission(jobDir);
  if (!allowed) {
    throw new Error("Permission denied. Select your output folder again.");
  }

  const folderName =
    String(jobDir.name || "resume-bot")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "resume-bot";

  let lastDownloadId = null;
  const openedNames = [];

  try {
    for await (const entry of jobDir.values()) {
      if (entry.kind !== "file") continue;
      const name = String(entry.name || "");
      if (!/\.(pdf|html|txt)$/i.test(name)) continue;

      const file = await entry.getFile();
      const url = URL.createObjectURL(file);
      try {
        const downloadId = await chrome.downloads.download({
          url,
          filename: `${folderName}/${name}`,
          conflictAction: "uniquify",
          saveAs: false
        });
        if (downloadId != null) {
          lastDownloadId = downloadId;
          openedNames.push(name);
        }
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
  } catch (downloadErr) {
    // If Chrome is set to "Ask where to save", downloads may fail/abort.
    // Fall back to a file picker rooted at the real job folder (shows PDFs).
    if (typeof window.showOpenFilePicker === "function") {
      try {
        await window.showOpenFilePicker({
          multiple: true,
          startIn: jobDir,
          types: [
            {
              description: "Resume files",
              accept: {
                "application/pdf": [".pdf"],
                "text/html": [".html"],
                "text/plain": [".txt"]
              }
            }
          ]
        });
        return { ok: true, method: "file-picker", folderName };
      } catch (pickerErr) {
        if (
          pickerErr &&
          (pickerErr.name === "AbortError" ||
            String(pickerErr.message || "").includes("abort"))
        ) {
          return { ok: true, method: "file-picker", aborted: true, folderName };
        }
        throw downloadErr;
      }
    }
    throw downloadErr;
  }

  if (lastDownloadId == null) {
    // No downloadable files — still try file picker on the real folder.
    if (typeof window.showOpenFilePicker === "function") {
      await window.showOpenFilePicker({
        multiple: true,
        startIn: jobDir
      });
      return { ok: true, method: "file-picker", folderName };
    }
    throw new Error("No resume/cover letter files found in the saved folder.");
  }

  // Reveal the last file in File Explorer (shows the folder + files).
  try {
    chrome.downloads.show(Number(lastDownloadId));
  } catch (err) {
    throw new Error(String(err?.message || err) || "Could not open Downloads folder.");
  }

  await setLastSaveMeta(
    {
      ...(await getLastSaveMeta()),
      downloadId: lastDownloadId,
      revealFolder: `Downloads / ${folderName}`,
      files: openedNames
    },
    { announce: false }
  );

  return {
    ok: true,
    method: "downloads-show",
    downloadId: lastDownloadId,
    folderName,
    files: openedNames
  };
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
export async function flushPendingOutputToSelectedDirectory() {
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

  const result = await writeJobFilesToDirectory(root, pending.folderName, pending.files);
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
