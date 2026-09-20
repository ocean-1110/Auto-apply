/**
 * Shared helpers for per-site job scrapers (content/scrapers/*.js).
 * Each site file calls OceanScrape.register({ id, label, hosts, scrape }).
 */
(function (root) {
  const BUILD = "2026-08-27.scrape-topframe.1";
  const Ocean = root.OceanScrape || (root.OceanScrape = {});
  if (Ocean.helperBuild === BUILD) return;
  Ocean.helperBuild = BUILD;
  Ocean.sites = Ocean.sites || {};

  Ocean.register = function register(entry) {
    if (!entry?.id || typeof entry.scrape !== "function") return;
    Ocean.sites[entry.id] = entry;
  };

  function htmlToPlainText(html) {
    let s = String(html || "");
    if (!s) return "";
    s = s
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "- ")
      .replace(/<\/\s*li\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|h[1-6]|ul|ol|section|article|tr|table)\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&rsquo;/gi, "\u2019")
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) ? String.fromCharCode(code) : _;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
        const code = parseInt(n, 16);
        return Number.isFinite(code) ? String.fromCharCode(code) : _;
      });
    return s
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readJsonScript(id, rootEl = document) {
    const el =
      typeof rootEl.getElementById === "function"
        ? rootEl.getElementById(id)
        : rootEl.querySelector(`#${CSS.escape(id)}`);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || el.innerText || "");
    } catch {
      return null;
    }
  }

  function canonicalPageUrl() {
    const link = document.querySelector('link[rel="canonical"]');
    const href = link?.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) return href;
    try {
      const u = new URL(location.href);
      u.hash = "";
      return u.toString();
    } catch {
      return location.href;
    }
  }

  function normalizeEmploymentType(value) {
    const v = String(Array.isArray(value) ? value[0] : value || "").trim();
    if (!v) return "";
    const map = {
      FULL_TIME: "Full-time",
      PART_TIME: "Part-time",
      CONTRACTOR: "Contract",
      CONTRACT: "Contract",
      TEMPORARY: "Temporary",
      INTERN: "Internship",
      INTERNSHIP: "Internship",
      VOLUNTEER: "Volunteer",
      PER_DIEM: "Per diem",
      OTHER: "Other"
    };
    return map[v.toUpperCase().replace(/[\s-]+/g, "_")] || v;
  }

  function sectionLines(title, arr) {
    const items = (Array.isArray(arr) ? arr : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    if (!items.length) return [];
    return [`${title}:`, ...items.map((it) => `- ${it}`), ""];
  }

  function salaryBoundsFromText(text) {
    const t = String(text || "");
    const m = t.match(/\$\s*([\d,]+)(?:\s*(k))?\s*[-–—to]+\s*\$?\s*([\d,]+)\s*(k)?/i);
    if (!m) return { salaryMin: "", salaryMax: "" };
    const minScale = m[2] ? 1000 : 1;
    const maxScale = m[4] ? 1000 : m[2] ? 1000 : 1;
    const min = Number(String(m[1]).replace(/,/g, "")) * minScale;
    const max = Number(String(m[3]).replace(/,/g, "")) * maxScale;
    return {
      salaryMin: Number.isFinite(min) ? String(min) : "",
      salaryMax: Number.isFinite(max) ? String(max) : ""
    };
  }

  function elementText(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function queryAllDeep(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node) return;
      try {
        if (node.querySelectorAll) out.push(...node.querySelectorAll(selector));
      } catch {
        /* invalid selector in this root */
      }
      const tree = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const el of tree) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function findJobPostingLdJson(root = document) {
    const scripts = queryAllDeep('script[type="application/ld+json"]', root);
    for (const s of scripts) {
      let data;
      try {
        data = JSON.parse(s.textContent || "");
      } catch {
        continue;
      }
      const nodes = Array.isArray(data)
        ? data
        : Array.isArray(data?.["@graph"])
          ? data["@graph"]
          : [data];
      for (const node of nodes) {
        const type = node?.["@type"];
        const isJob =
          type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        if (isJob) return node;
      }
    }
    return null;
  }

  function inferTitleFromJd(jdText) {
    return (String(jdText || "").match(/seeking a\s+([A-Z][A-Za-z0-9 /&+-]{3,80})\s+to join/i) || [])[1] || "";
  }

  function inferCompanyFromJd(jdText) {
    return (
      (String(jdText || "").match(/^([A-Z][A-Za-z0-9 .,&'-]{2,80})\s+is (?:the|a|an|seeking)/m) || [])[1] || ""
    );
  }

  function inferLocationFromJd(jdText) {
    return (String(jdText || "").match(/\bbased in\s+([^.\n]{4,80})/i) || [])[1] || "";
  }

  function inferEmploymentFromJd(jdText) {
    const t = String(jdText || "");
    if (/\bfull[-\s]?time\b/i.test(t)) return "Full-time";
    if (/\bpart[-\s]?time\b/i.test(t)) return "Part-time";
    if (/\bcontract\b/i.test(t)) return "Contract";
    return "";
  }

  function inferRemoteFromText(text) {
    const t = String(text || "");
    if (/\bthis position is remote\b/i.test(t) || /\bworkplace[_\s-]?type["']?\s*[:=]\s*["']?remote\b/i.test(t)) {
      return "Remote";
    }
    if (/\bremote\b/i.test(t) && !/\bnot remote\b/i.test(t)) return "Remote";
    if (/\bhybrid\b/i.test(t)) return "Hybrid";
    if (/\bon[-\s]?site\b/i.test(t)) return "On-site";
    return "";
  }

  function mergeJobData(...cands) {
    let best = null;
    for (const c of cands) {
      if (!c) continue;
      if (!best) {
        best = { ...c };
        continue;
      }
      for (const [k, v] of Object.entries(c)) {
        if (v && !best[k]) best[k] = v;
        if (k === "jdText" && String(v).length > String(best.jdText || "").length) best[k] = v;
      }
    }
    return best;
  }

  Ocean.helpers = {
    htmlToPlainText,
    readJsonScript,
    canonicalPageUrl,
    normalizeEmploymentType,
    sectionLines,
    salaryBoundsFromText,
    elementText,
    queryAllDeep,
    findJobPostingLdJson,
    inferTitleFromJd,
    inferCompanyFromJd,
    inferLocationFromJd,
    inferEmploymentFromJd,
    inferRemoteFromText,
    mergeJobData
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
