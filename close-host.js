/** Close a tool page. Inside the main panel overlay, return there instead of spawning/closing windows. */
export function closeHostWindow() {
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type: "ocean-close-subpage" }, "*");
      return;
    } catch {
      /* ignore */
    }
  }
  window.close();
}

if (window.parent && window.parent !== window) {
  document.documentElement.classList.add("ocean-in-panel");
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeHostWindow();
  });
}
