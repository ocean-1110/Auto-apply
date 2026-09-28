/**
 * Parse AI contact JSON for Email Bid.
 * Fields: name, email, role, phone (optional).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /[\d+().\-\s]{7,}/;

/**
 * @param {string} text
 */
export function extractContactsJson(text) {
  const raw = String(text || "");
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 */
function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw || !PHONE_RE.test(raw)) return "";
  // Reject obvious non-phones / placeholders
  if (/^(n\/?a|none|unknown|null)$/i.test(raw)) return "";
  return raw.replace(/\s+/g, " ").slice(0, 40);
}

/**
 * @param {object|null} parsed
 */
export function normalizeContacts(parsed) {
  const list = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const email = String(c?.email || "")
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    // Legacy AI replies may still include confidence — drop weak guesses.
    const confidence = Number(c?.confidence);
    if (Number.isFinite(confidence) && confidence < 0.35) continue;
    seen.add(email);
    out.push({
      name: String(c?.name || "").trim(),
      email,
      role: String(c?.role || "").trim(),
      phone: normalizePhone(c?.phone)
    });
  }
  return out.slice(0, 8);
}

/**
 * @param {string} aiText
 * @param {{ company?: string }} [_opts]
 */
export function harvestContactsFromAiText(aiText, _opts = {}) {
  return normalizeContacts(extractContactsJson(aiText));
}

const EMAIL_FIND_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function isJunkContactEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return true;
  if (/^(noreply|no-reply|donotreply|mailer-daemon|notifications?)@/.test(e)) return true;
  if (/@(example|email|domain|sentry)\./.test(e)) return true;
  return false;
}

function nameNearEmail(snippet) {
  const before = String(snippet || "");
  const labeled = before.match(
    /(?:thanks|thank you|regards|sincerely|best|contact|posted by|recruiter|from)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,2})/i
  );
  if (labeled?.[1]) return labeled[1].replace(/[,;]+$/, "").trim();
  const explicit = before.match(
    /(?:^|[\n,])\s*(?:name|contact)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,2})/i
  );
  if (explicit?.[1]) return explicit[1].trim();
  const names = [...before.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,2})\b/g)];
  const last = names.length ? names[names.length - 1][1] : "";
  if (!last) return "";
  if (/^(email|phone|location|company|united states|job description)$/i.test(last)) return "";
  return last.trim();
}

function roleNearEmail(snippet, fallbackRole = "") {
  const s = String(snippet || "");
  if (/\b(talent acquisition|recruiter|recruiting)\b/i.test(s)) return "Recruiter";
  if (/\b(human resources|\bhr\b|people ops)\b/i.test(s)) return "HR";
  if (/\bhiring manager\b/i.test(s)) return "Hiring Manager";
  if (/\b(team lead|engineering manager|delivery lead)\b/i.test(s)) return "Hiring lead";
  if (/\b(cto|vp engineering|director)\b/i.test(s)) return "Technical lead";
  return String(fallbackRole || "").trim() || "Hiring contact";
}

function phoneNearEmail(snippet) {
  const m = String(snippet || "").match(
    /(?:phone|tel|mobile|cell)\s*[:\-]?\s*(\+?\d[\d\s().-]{7,}\d)/i
  );
  if (m?.[1]) return normalizePhone(m[1]);
  const loose = String(snippet || "").match(/\+\d[\d\s().-]{8,}\d/);
  return loose ? normalizePhone(loose[0]) : "";
}

/**
 * Contacts already written in the JD or poster line. Never invents addresses.
 * @param {string} text
 * @param {{ role?: string, title?: string }} [opts]
 */
export function extractContactsFromJobText(text, opts = {}) {
  const raw = String(text || "");
  const fallbackRole = String(opts.role || opts.title || "").trim();
  const found = [];
  for (const match of raw.matchAll(EMAIL_FIND_RE)) {
    const email = String(match[0] || "").trim().toLowerCase();
    if (isJunkContactEmail(email)) continue;
    const idx = match.index || 0;
    const snippet = raw.slice(Math.max(0, idx - 220), Math.min(raw.length, idx + email.length + 80));
    found.push({
      name: nameNearEmail(snippet.slice(0, snippet.toLowerCase().indexOf(email))),
      email,
      role: roleNearEmail(snippet, fallbackRole ? "Hiring contact" : ""),
      phone: phoneNearEmail(snippet)
    });
  }
  return normalizeContacts({ contacts: found });
}

/**
 * Dedupe by email. Earlier lists win; later lists fill blank name/role/phone.
 * @param {...Array<{name?: string, email?: string, role?: string, phone?: string}>} lists
 */
export function mergeContacts(...lists) {
  const byEmail = new Map();
  for (const list of lists) {
    for (const c of list || []) {
      const email = String(c?.email || "")
        .trim()
        .toLowerCase();
      if (isJunkContactEmail(email)) continue;
      const next = {
        name: String(c?.name || "").trim(),
        email,
        role: String(c?.role || "").trim(),
        phone: normalizePhone(c?.phone)
      };
      const prev = byEmail.get(email);
      if (!prev) {
        byEmail.set(email, next);
        continue;
      }
      if (!prev.name && next.name) prev.name = next.name;
      if (!prev.role && next.role) prev.role = next.role;
      if (!prev.phone && next.phone) prev.phone = next.phone;
    }
  }
  return [...byEmail.values()].slice(0, 8);
}

export { EMAIL_RE };
