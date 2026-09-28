/**
 * Wait until a tab reports status "complete".
 * Polls as well as listening: background data: tabs often never emit "complete".
 */
export function awaitTabComplete(
  tabId,
  timeoutMs = 15000,
  timeoutMessage = "Timed out waiting for tab to finish loading."
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    let poll = 0;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };

    timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    poll = setInterval(() => {
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab?.status === "complete") finish();
        })
        .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    }, 250);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}
