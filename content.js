/**
 * Keyboard shortcuts on ChatGPT (no popup needed):
 * - Double-tap Ctrl (JetBrains-style), or
 * - Ctrl+Shift+V
 * Reads resume JSON from the clipboard and runs the same render + cover letter
 * pipeline as the popup "Render resume & cover letter" button.
 *
 * Reload the extension, then refresh the ChatGPT tab after installing/updating.
 */
(() => {
  const DOUBLE_TAP_MS = 500;
  const DEFAULT_OUTPUT_DIR = "Resume Applications";
  const DEFAULT_TEMPLATE_ID = "classic-blue";

  let lastCtrlTap = 0;
  let ctrlUsedAsModifier = false;
  let busy = false;
  let pasteFallbackOpen = false;

  let toastEl = null;
  let toastTimer = null;

  function showToast(message, { sticky = false } = {}) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("data-resume-gpt-toast", "1");
      Object.assign(toastEl.style, {
        position: "fixed",
        zIndex: "2147483647",
        right: "16px",
        bottom: "16px",
        maxWidth: "380px",
        padding: "12px 14px",
        background: "#1f3b5a",
        color: "#fff",
        font: "13px/1.4 Arial, Helvetica, sans-serif",
        borderRadius: "8px",
        boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
        whiteSpace: "pre-wrap"
      });
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = message;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!sticky) {
      toastTimer = setTimeout(hideToast, 7000);
    }
  }

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastEl && toastEl.parentNode) {
      toastEl.parentNode.removeChild(toastEl);
    }
    toastEl = null;
  }

  async function loadJobMeta() {
    const s = await chrome.storage.local.get([
      "last_job_title",
      "last_company_name",
      "last_jd_link",
      "last_jd_text",
      "output_dir",
      "spreadsheet_url",
      "sheets_web_app_url",
      "selected_template_id"
    ]);
    return {
      jobTitle: s.last_job_title || "",
      companyName: s.last_company_name || "",
      jdLink: s.last_jd_link || "",
      jdText: s.last_jd_text || "",
      outputDir: (s.output_dir || "").trim() || DEFAULT_OUTPUT_DIR,
      spreadsheetUrl: (s.spreadsheet_url || "").trim(),
      sheetsWebAppUrl: (s.sheets_web_app_url || "").trim(),
      templateId: s.selected_template_id || DEFAULT_TEMPLATE_ID
    };
  }

  async function readClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, text: (text || "").trim() };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function looksLikeResumeJson(text) {
    const t = String(text || "").trim();
    return t.includes("{") && (t.includes('"experience"') || t.includes('"name"') || t.includes("experience"));
  }

  async function startRender(jsonText) {
    const jobMeta = await loadJobMeta();
    if (!String(jobMeta.jobTitle || "").trim() || !String(jobMeta.companyName || "").trim()) {
      showToast(
        "Fill Job title and Company in the extension popup first, then try the shortcut again."
      );
      return;
    }
    if (!String(jobMeta.jdText || "").trim()) {
      showToast("Paste a job description in the extension popup first, then try again.");
      return;
    }

    showToast("Rendering resume & cover letter...", { sticky: true });
    const res = await chrome.runtime.sendMessage({
      type: "save_from_json",
      jsonText,
      jobMeta
    });

    if (res && res.ok === false) {
      showToast(`Could not start: ${res.error || "unknown error"}`);
    }
  }

  function openPasteFallback() {
    if (pasteFallbackOpen) return;
    pasteFallbackOpen = true;
    hideToast();

    const overlay = document.createElement("div");
    overlay.setAttribute("data-resume-gpt-paste", "1");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "rgba(0,0,0,0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px"
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(560px, 100%)",
      background: "#fff",
      color: "#111",
      borderRadius: "10px",
      padding: "16px",
      boxShadow: "0 8px 28px rgba(0,0,0,0.3)",
      font: "14px/1.4 Arial, Helvetica, sans-serif"
    });

    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;">Paste resume JSON</div>
      <div style="margin-bottom:10px;color:#444;font-size:13px;">
        Clipboard access was blocked. Click the box and press <b>Ctrl+V</b>, then click Render
        (or press Ctrl+Enter).
      </div>
    `;

    const ta = document.createElement("textarea");
    ta.rows = 10;
    Object.assign(ta.style, {
      width: "100%",
      boxSizing: "border-box",
      font: "12px/1.35 Consolas, monospace",
      padding: "8px",
      border: "1px solid #ccc",
      borderRadius: "6px",
      resize: "vertical"
    });
    ta.placeholder = 'Paste the full JSON object here, starting with { ... }';

    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      gap: "8px",
      marginTop: "10px",
      justifyContent: "flex-end"
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    Object.assign(cancelBtn.style, {
      padding: "8px 12px",
      border: "1px solid #ccc",
      borderRadius: "6px",
      background: "#f5f5f5",
      cursor: "pointer"
    });

    const renderBtn = document.createElement("button");
    renderBtn.type = "button";
    renderBtn.textContent = "Render";
    Object.assign(renderBtn.style, {
      padding: "8px 12px",
      border: "none",
      borderRadius: "6px",
      background: "#1f3b5a",
      color: "#fff",
      cursor: "pointer"
    });

    const close = () => {
      pasteFallbackOpen = false;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    const submit = async () => {
      const text = (ta.value || "").trim();
      if (!looksLikeResumeJson(text)) {
        ta.focus();
        return;
      }
      close();
      busy = true;
      try {
        await startRender(text);
      } catch (err) {
        showToast(`Shortcut failed: ${String((err && err.message) || err)}`);
      } finally {
        busy = false;
      }
    };

    cancelBtn.addEventListener("click", close);
    renderBtn.addEventListener("click", () => {
      submit().catch(() => {});
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit().catch(() => {});
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    row.appendChild(cancelBtn);
    row.appendChild(renderBtn);
    panel.appendChild(ta);
    panel.appendChild(row);
    overlay.appendChild(panel);
    (document.body || document.documentElement).appendChild(overlay);
    setTimeout(() => ta.focus(), 50);
  }

  async function onShortcut() {
    if (busy || pasteFallbackOpen) return;
    busy = true;
    try {
      showToast("Reading resume JSON from clipboard...\n(Ctrl twice or Ctrl+Shift+V)", {
        sticky: true
      });
      const clip = await readClipboard();

      if (!clip.ok) {
        showToast("Clipboard blocked — use the paste box...");
        openPasteFallback();
        return;
      }
      if (!clip.text || !looksLikeResumeJson(clip.text)) {
        showToast(
          "Clipboard doesn't look like resume JSON.\nCopy the JSON from ChatGPT, then press Ctrl twice (or Ctrl+Shift+V)."
        );
        return;
      }

      await startRender(clip.text);
    } catch (err) {
      showToast(`Shortcut failed: ${String((err && err.message) || err)}`);
    } finally {
      busy = false;
    }
  }

  // Ctrl+Shift+V — clear alternate shortcut
  window.addEventListener(
    "keydown",
    (e) => {
      const key = String(e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "v") {
        // Don't steal normal paste inside inputs unless we want the render flow.
        // Always run on ChatGPT for this dedicated combo.
        e.preventDefault();
        e.stopPropagation();
        onShortcut();
      }
    },
    true
  );

  // Double-tap Ctrl (ignores Ctrl used in combos like Ctrl+C)
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Control") {
        if (!e.repeat) ctrlUsedAsModifier = false;
      } else if (e.ctrlKey) {
        ctrlUsedAsModifier = true;
      }
    },
    true
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (e.key !== "Control") return;
      if (ctrlUsedAsModifier) {
        ctrlUsedAsModifier = false;
        return;
      }
      const now = Date.now();
      if (now - lastCtrlTap < DOUBLE_TAP_MS) {
        lastCtrlTap = 0;
        onShortcut();
      } else {
        lastCtrlTap = now;
      }
    },
    true
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.generation_status || !toastEl) return;
    const status = changes.generation_status.newValue || "";
    const done = /saved to downloads|generation failed|saved resume to downloads/i.test(status);
    showToast(status, { sticky: !done });
  });
})();
