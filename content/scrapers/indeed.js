/**
 * Indeed job-page extractor. Hosted Indeed Apply vs an external company link
 * is recorded so Auto Apply can stay capture-only on external postings.
 */
(function () {
  const Ocean = globalThis.OceanScrape;
  if (!Ocean?.helpers) return;
  const {
    htmlToPlainText,
    canonicalPageUrl,
    elementText,
    findJobPostingLdJson
  } = Ocean.helpers;

  function indeedJobKey(url = location.href) {
    try {
      const u = new URL(String(url || ""), "https://www.indeed.com");
      return u.searchParams.get("jk") || u.searchParams.get("vjk") || "";
    } catch {
      return "";
    }
  }

  function indeedCanonicalLink(jobKey) {
    if (jobKey) return `https://www.indeed.com/viewjob?jk=${encodeURIComponent(jobKey)}`;
    return typeof canonicalPageUrl === "function" ? canonicalPageUrl() : location.href;
  }

  function scrapeIndeedDom(doc = document) {
    const root =
      doc.querySelector("#jobsearch-ViewjobPaneWrapper") ||
      doc.querySelector(".jobsearch-JobComponent") ||
      doc.querySelector("main") ||
      doc.body;
    const text = (selector) => (typeof elementText === "function" ? elementText(root.querySelector(selector)) : "");
    const descEl =
      root.querySelector("#jobDescriptionText") ||
      root.querySelector('[data-testid="jobDescriptionText"]') ||
      root.querySelector('[itemprop="description"]');
    const desc = descEl
      ? htmlToPlainText(descEl.innerHTML || descEl.textContent || "")
      : "";
    const pageText = typeof elementText === "function" ? elementText(root) : root.innerText || "";
    const location =
      text('[data-testid="job-location"]') ||
      text('[data-testid="inlineHeader-companyLocation"]') ||
      text(".jobsearch-JobInfoHeader-subtitle div");
    const external = root.querySelector(
      'a[href*="indeed.com/rc/clk"], a[data-testid*="external"], button[data-testid*="external"]'
    );
    const applyOnIndeed = Boolean(
      root.querySelector(
        '#indeedApplyButton, button[id*="indeedApply"], a[id*="indeedApply"], [data-testid*="indeedApply"]'
      )
    ) || /\bapply with indeed\b|\beasily apply\b|\bapply on indeed\b/i.test(pageText);
    return {
      jobTitle:
        text('[data-testid="jobsearch-JobInfoHeader-title"]') ||
        text(".jobsearch-JobInfoHeader-title") ||
        text("h1"),
      companyName:
        text('[data-testid="inlineHeader-companyName"]') ||
        text('[data-company-name="true"]') ||
        text(".jobsearch-InlineCompanyRating-companyHeader"),
      jdText: desc,
      jobLocation: location,
      applyOnIndeed: applyOnIndeed && !external,
      hostedApply: applyOnIndeed && !external,
      externalApply: Boolean(external) && !applyOnIndeed,
      workArrangement: /\bremote\b/i.test(`${location} ${pageText}`) ? "Remote" : ""
    };
  }

  function scrapeIndeedSchema() {
    const node = typeof findJobPostingLdJson === "function" ? findJobPostingLdJson() : null;
    if (!node) return null;
    const jobTitle = String(node.title || node.name || "").trim();
    const org = node.hiringOrganization;
    const companyName = String(
      (org && (org.name || org.legalName)) || (typeof org === "string" ? org : "") || ""
    ).trim();
    const jdText = htmlToPlainText(node.description || "");
    if (!jobTitle && !jdText) return null;
    const direct = String(node.directApply ?? "");
    return {
      jobTitle,
      companyName,
      jdText,
      hostedApply: direct === "true" || direct === true,
      datePosted: String(node.datePosted || "").trim()
    };
  }

  async function scrapeIndeed() {
    const jobKey = indeedJobKey();
    let dom = scrapeIndeedDom(document);
    let schema = scrapeIndeedSchema();
    const thin = !dom?.jdText || String(dom.jdText).length < 80;
    if (thin) {
      for (const waitMs of [400, 900]) {
        await new Promise((r) => setTimeout(r, waitMs));
        dom = scrapeIndeedDom(document);
        schema = scrapeIndeedSchema() || schema;
        if (dom?.jobTitle && String(dom.jdText || "").length >= 80) break;
      }
    }
    const jobTitle = dom?.jobTitle || schema?.jobTitle || "";
    const jdText = String(dom?.jdText || "").length >= String(schema?.jdText || "").length
      ? dom?.jdText || ""
      : schema?.jdText || "";
    if (!jobTitle && !jdText) return null;
    const hosted = Boolean(dom?.hostedApply || schema?.hostedApply);
    return {
      jobId: jobKey,
      jobTitle,
      companyName: dom?.companyName || schema?.companyName || "",
      jdText,
      jdLink: indeedCanonicalLink(jobKey),
      applyLink: indeedCanonicalLink(jobKey),
      jobLocation: dom?.jobLocation || "",
      workArrangement: dom?.workArrangement || "",
      hostedApply: hosted,
      applyOnIndeed: hosted,
      externalApply: Boolean(dom?.externalApply) && !hosted,
      datePosted: schema?.datePosted || "",
      source: "indeed"
    };
  }

  Ocean.register({
    id: "indeed",
    label: "Indeed",
    hosts: [/(^|\.)indeed\.com$/i],
    scrape: scrapeIndeed
  });
})();
