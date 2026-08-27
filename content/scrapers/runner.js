/**
 * Dispatches ocean_scrape_page to the selected (or auto-detected) site extractor.
 * Only the top frame answers scrape — child iframes used to reply first with
 * "could not detect" and win chrome.tabs.sendMessage.
 */
(function () {
  const Ocean = globalThis.OceanScrape;
  if (!Ocean) return;

  function hostOf(entry, hostname) {
    const host = String(hostname || "");
    return (entry.hosts || []).some((re) => {
      try {
        return re.test(host);
      } catch {
        return false;
      }
    });
  }

  function matchingSites(hostname) {
    const sites = Ocean.sites || {};
    return Object.values(sites).filter(
      (s) => s.id && s.id !== "schema" && hostOf(s, hostname)
    );
  }

  async function tryScrape(entry, hints) {
    if (!entry || typeof entry.scrape !== "function") return null;
    const data = await entry.scrape(hints || {});
    if (data && (data.jobTitle || data.jdText)) {
      return { ok: true, site: entry.id, jobData: data };
    }
    return null;
  }

  async function scrapeJobPage(siteId, hints = {}) {
    const requested = String(siteId || "auto").trim().toLowerCase() || "auto";
    const host = location.hostname || "";
    const sites = Ocean.sites || {};
    const schema = sites.schema;

    if (requested && requested !== "auto") {
      const entry = sites[requested];
      if (!entry) {
        return {
          ok: false,
          error: `No extractor registered for "${requested}". Reload the extension, then refresh this tab.`
        };
      }
      try {
        const hit = await tryScrape(entry, hints);
        if (hit) return hit;
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
      return {
        ok: false,
        error:
          requested === "hiringcafe"
            ? "Could not extract this HiringCafe job. Open the job details sidebar, wait for it to load, then scrape again."
            : `Could not extract job details with the ${entry.label || requested} extractor on ${host}. Wait for the page to finish loading, or paste the JD.`
      };
    }

    const ordered = matchingSites(host);
    for (const entry of ordered) {
      try {
        const hit = await tryScrape(entry, hints);
        if (hit) return hit;
      } catch {
        /* try next / schema fallback */
      }
    }

    try {
      const hit = await tryScrape(schema, hints);
      if (hit) return hit;
    } catch {
      /* ignore */
    }

    if (ordered.some((s) => s.id === "hiringcafe")) {
      return {
        ok: false,
        error:
          "Could not extract this HiringCafe job. Open the job details sidebar, wait for it to load, then scrape again."
      };
    }
    if (ordered.some((s) => s.id === "dice")) {
      return {
        ok: false,
        error:
          "Could not extract this Dice job. Open the job (or the details panel on search), wait for the description to appear, then scrape again."
      };
    }

    return {
      ok: false,
      error: `Could not detect job details on ${host || "this page"} yet. Pick the job site above, wait for the details panel to finish loading, or paste the JD manually.`
    };
  }

  Ocean.run = scrapeJobPage;

  if (window !== window.top) return;

  if (!globalThis.__oceanScrapeListenerBound) {
    globalThis.__oceanScrapeListenerBound = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "ocean_scrape_page" && message?.type !== "scrape_job_page") {
        return undefined;
      }
      const run = Ocean.run || scrapeJobPage;
      run(message.siteId || message.site || "auto", message.hints || {})
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    });
  }
})();
