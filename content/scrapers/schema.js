/**
 * Generic schema.org JobPosting extractor (JSON-LD). Fallback for any site.
 */
(function () {
  const Ocean = globalThis.OceanScrape;
  if (!Ocean?.helpers) return;
  const {
    htmlToPlainText,
    canonicalPageUrl,
    normalizeEmploymentType,
    findJobPostingLdJson
  } = Ocean.helpers;

  function extractSchemaLocation(node) {
    const loc = Array.isArray(node?.jobLocation) ? node.jobLocation[0] : node?.jobLocation;
    const addr = loc?.address || {};
    return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(", ");
  }

  function scrapeSchemaOrgJobPosting() {
    const node = findJobPostingLdJson();
    if (!node) return null;

    const jobTitle = String(node.title || node.name || "").trim();
    const org = node.hiringOrganization;
    const companyName = String(
      (org && (org.name || org.legalName)) || (typeof org === "string" ? org : "") || ""
    ).trim();
    const jdText = htmlToPlainText(node.description || "");
    if (!jobTitle && !jdText) return null;

    const salaryValue = node.baseSalary?.value || node.estimatedSalary?.value || {};
    const remote =
      String(node.jobLocationType || "").toUpperCase() === "TELECOMMUTE" ? "Remote" : "";

    return {
      jobTitle,
      companyName,
      jdLink: canonicalPageUrl(),
      jdText,
      applyLink: String(node.url || "").trim(),
      workArrangement: remote,
      employmentType: normalizeEmploymentType(node.employmentType),
      salaryMin: salaryValue.minValue != null ? String(salaryValue.minValue) : "",
      salaryMax: salaryValue.maxValue != null ? String(salaryValue.maxValue) : "",
      datePosted: String(node.datePosted || "").trim(),
      jobLocation: extractSchemaLocation(node),
      source: "schema.org"
    };
  }

  Ocean.helpers.findJobPostingLdJson = findJobPostingLdJson;
  Ocean.helpers.scrapeSchemaOrgJobPosting = scrapeSchemaOrgJobPosting;

  Ocean.register({
    id: "schema",
    label: "Generic (schema.org / any page)",
    hosts: [],
    scrape: scrapeSchemaOrgJobPosting
  });
})();
