/**
 * Free contact discovery: resolve company domain + scrape public pages.
 * Never invents emails — only extracts addresses already published on pages.
 */

import {
  extractContactsFromJobText,
  mergeContacts,
  normalizeContacts
} from "./email-contacts.js";

const JOB_BOARD_HOST_RE =
  /(^|\.)(linkedin|indeed|dice|ziprecruiter|jobright|glassdoor|monster|simplyhired|greenhouse|lever|myworkdayjobs|workdayjobs|ashbyhq|smartrecruiters|icims|taleo|jobvite|bamboohr|ultipro|jobgether|braintrust|usebraintrust|wellfound|angel\.co)\./i;

const CONTACT_PATHS = ["", "/contact", "/about", "/team", "/people", "/careers", "/company", "/about-us", "/contact-us"];

/**
 * @param {string} host
 */
export function isJobBoardHost(host) {
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!h) return true;
  return JOB_BOARD_HOST_RE.test(h) || JOB_BOARD_HOST_RE.test(`.${h}`);
}

/**
 * @param {string} company
 */
export function slugCompanyName(company) {
  return String(company || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|ag|sa|bv|oy|ab)\b\.?/gi, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim()
    .slice(0, 48);
}

/**
 * Build candidate company website origins (https://host). Never invents emails.
 * @param {{ company?: string, jdLink?: string, emails?: string[] }} opts
 * @returns {string[]}
 */
export function resolveCompanyDomainCandidates(opts = {}) {
  const out = [];
  const seen = new Set();
  const pushHost = (host) => {
    const h = String(host || "")
      .trim()
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/:\d+$/, "");
    if (!h || !h.includes(".") || isJobBoardHost(h)) return;
    if (seen.has(h)) return;
    seen.add(h);
    out.push(`https://${h}`);
  };

  try {
    const link = String(opts.jdLink || "").trim();
    if (link && /^https?:\/\//i.test(link)) {
      pushHost(new URL(link).hostname);
    }
  } catch {
    /* ignore */
  }

  for (const email of opts.emails || []) {
    const domain = String(email || "")
      .trim()
      .toLowerCase()
      .split("@")[1];
    pushHost(domain);
  }

  const slug = slugCompanyName(opts.company);
  if (slug && slug.length >= 3) {
    // Probe only — used as fetch targets, never as invented mailbox local-parts.
    for (const tld of ["com", "io", "co", "net", "ai"]) {
      pushHost(`${slug}.${tld}`);
    }
  }

  return out.slice(0, 6);
}

/**
 * Strip tags lightly for snippet context (not a full HTML parser).
 * @param {string} html
 */
export function htmlToSearchText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract published emails from HTML (mailto + visible addresses).
 * @param {string} html
 * @param {{ role?: string }} [opts]
 */
export function extractContactsFromHtml(html, opts = {}) {
  const raw = String(html || "");
  if (!raw) return [];
  const text = htmlToSearchText(raw);
  const emails = new Set();

  for (const m of raw.matchAll(/mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    const email = String(m[1] || "")
      .trim()
      .toLowerCase();
    if (email) emails.add(email);
  }
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    emails.add(String(m[0] || "").trim().toLowerCase());
  }

  const ranked = [...emails].map((email) => {
    const local = email.split("@")[0] || "";
    let score = 0;
    if (/^(careers?|jobs?|recruit|talent|hr|people|hiring)/i.test(local)) score += 50;
    if (/^(info|hello|support|sales|admin|webmaster)$/i.test(local)) score -= 10;
    return { email, score };
  });
  ranked.sort((a, b) => b.score - a.score);

  // Build a synthetic blob so name/role heuristics can run near each address.
  const blob = [
    text.slice(0, 12000),
    ...ranked.map(({ email }) => `Email: ${email}`)
  ].join("\n");
  return extractContactsFromJobText(blob, { role: opts.role || "Hiring contact" });
}

/**
 * @param {string} origin https://example.com
 * @param {string} path
 */
function pageUrl(origin, path) {
  try {
    return new URL(path || "/", origin).toString();
  } catch {
    return "";
  }
}

/**
 * Fetch a few public company pages and harvest mailto/emails.
 * @param {{ company?: string, jdLink?: string, jdText?: string, title?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 */
export async function discoverPublicCompanyContacts(opts = {}) {
  const fromJob = extractContactsFromJobText(
    [opts.jdText, opts.posterHint].filter(Boolean).join("\n"),
    { role: opts.title || "" }
  );
  const emails = fromJob.map((c) => c.email);
  const origins = resolveCompanyDomainCandidates({
    company: opts.company,
    jdLink: opts.jdLink,
    emails
  });
  if (!origins.length) return [];

  const fetchFn = typeof opts.fetchImpl === "function" ? opts.fetchImpl : fetch;
  const budgetMs = Math.max(3000, Number(opts.timeoutMs) || 10000);
  const started = Date.now();
  const paths = CONTACT_PATHS.slice(0, 7);
  /** @type {Array<{name: string, email: string, role: string, phone: string}>} */
  let collected = [];

  for (const origin of origins) {
    if (Date.now() - started > budgetMs) break;
    for (const path of paths) {
      if (Date.now() - started > budgetMs) break;
      const url = pageUrl(origin, path);
      if (!url) continue;
      try {
        const remaining = Math.max(1500, budgetMs - (Date.now() - started));
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), Math.min(4000, remaining)) : null;
        const res = await fetchFn(url, {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          signal: ctrl?.signal,
          headers: { Accept: "text/html,application/xhtml+xml" }
        });
        if (timer) clearTimeout(timer);
        if (!res?.ok) continue;
        const ctype = String(res.headers?.get?.("content-type") || "");
        if (ctype && !/html|text|xml/i.test(ctype)) continue;
        const html = await res.text();
        if (!html || html.length < 40) continue;
        const pageContacts = extractContactsFromHtml(html, {
          role: opts.title ? "Hiring contact" : "Hiring contact"
        });
        collected = mergeContacts(collected, pageContacts);
        if (collected.length >= 6) {
          return normalizeContacts({ contacts: collected });
        }
      } catch {
        /* soft — next URL */
      }
    }
  }

  return normalizeContacts({ contacts: collected });
}
