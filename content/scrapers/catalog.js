/**
 * Site list for the popup "Job site" selector.
 * Keep ids in sync with content/scrapers/{id}.js registrations.
 *
 * To add a site:
 *  1. Create content/scrapers/{id}.js that calls OceanScrape.register(...)
 *  2. Add an entry here
 *  3. Add the file to AUTOFILL_CONTENT_FILES in sw.js and manifest content_scripts
 *  4. Add the host to manifest content_scripts matches if autofill should load there
 */
(function (root) {
  const SCRAPE_SITES = [
    { id: "auto", label: "Auto-detect from this page" },
    { id: "hiringcafe", label: "HiringCafe", hosts: ["hiringcafe.com", "hiring.cafe"] },
    { id: "jobright", label: "Jobright", hosts: ["jobright.ai"] },
    { id: "dice", label: "Dice", hosts: ["dice.com"] },
    { id: "greenhouse", label: "Greenhouse", hosts: ["greenhouse.io"] },
    { id: "schema", label: "Generic (schema.org / any page)" }
  ];

  function hostMatches(site, hostname) {
    const host = String(hostname || "").toLowerCase();
    return (site.hosts || []).some((h) => host === h || host.endsWith(`.${h}`));
  }

  function detectScrapeSite(url) {
    try {
      const host = new URL(String(url || "")).hostname;
      const hit = SCRAPE_SITES.find((s) => s.id !== "auto" && s.id !== "schema" && hostMatches(s, host));
      return hit?.id || "auto";
    } catch {
      return "auto";
    }
  }

  root.OceanScrapeCatalog = { SCRAPE_SITES, detectScrapeSite, hostMatches };
})(typeof globalThis !== "undefined" ? globalThis : window);
