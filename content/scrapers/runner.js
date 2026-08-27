/**
 * Dispatches scrape_job_page to the selected (or auto-detected) site extractor.
 */
(function () {
  const BUILD = "2026-08-27.hiringcafe-scrape.1";
  if (globalThis.__oceanScrapeRunnerBuild === BUILD) return;
  globalThis.__oceanScrapeRunnerBuild = BUILD;

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

  async function tryScrape(entry) {
    if (!entry || typeof entry.scrape !== "function") return null;
    const data = await entry.scrape();
    if (data && (data.jobTitle || data.jdText)) {
      return { ok: true, site: entry.id, jobData: data };
    }
    return null;
  }

  async function scrapeJobPage(siteId) {
    const requested = String(siteId || "auto").trim().toLowerCase() || "auto";
    const host = location.hostname || "";
    const sites = Ocean.sites || {};
    const schema = sites.schema;

    if (requested && requested !== "auto") {
      const entry = sites[requested];
      if (!entry) {
        return {
          ok: false,
          error: `No extractor registered for "${requested}".`
        };
      }
      try {
        const hit = await tryScrape(entry);
        if (hit) return hit;
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
      return {
        ok: false,
        error:
          requested === "hiringcafe"
            ? "Could not extract this HiringCafe job. Open the job details sidebar, wait for it to load, then scrape again."
            : `Could not extract job details with the ${entry.label || requested} extractor. Wait for the page to finish loading, or paste the JD.`
      };
    }

    const ordered = Object.values(sites).filter((s) => s.id && s.id !== "schema");
    for (const entry of ordered) {
      if (!hostOf(entry, host)) continue;
      try {
        const hit = await tryScrape(entry);
        if (hit) return hit;
      } catch {
        /* try next / schema fallback */
      }
    }

    try {
      const hit = await tryScrape(schema);
      if (hit) return hit;
    } catch {
      /* ignore */
    }

    return {
      ok: false,
      error:
        "Could not detect job details on this page yet. Pick the job site above, wait for the details panel to finish loading, or paste the JD manually."
    };
  }

  Ocean.run = scrapeJobPage;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "ocean_scrape_page" && message?.type !== "scrape_job_page") {
      return undefined;
    }
    scrapeJobPage(message.siteId || message.site || "auto")
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
