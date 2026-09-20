/**
 * Wait until a tab reports status "complete".
 */
export function awaitTabComplete(
  tabId,
  timeoutMs = 15000,
  timeoutMessage = "Timed out waiting for tab to finish loading."
) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error(timeoutMessage));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Some URLs (e.g. data:) finish loading before the listener is attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}
