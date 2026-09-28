/**
 * AI prompt for a short, human, job-specific outreach email (cover-letter tone).
 */

import { classifyContactRole, pickPrimaryContact } from "./email-templates.js";

/**
 * Compact resume evidence for the compose prompt (keep token budget small).
 * @param {object|null} resumeJson
 * @param {object} person
 */
export function summarizeResumeForEmail(resumeJson, person = {}) {
  const name = String(person.name || person.fullName || "").trim();
  const title = String(person.title || resumeJson?.headline || "").trim();
  const years = person.yearsExperience || person.years || "";
  const skills = [];
  const raw = resumeJson?.skills;
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (typeof s === "string") skills.push(s);
      else if (s && typeof s === "object") {
        const items = s.items || s.skills || s.list;
        if (Array.isArray(items)) skills.push(...items.map(String));
        else if (s.name) skills.push(String(s.name));
      }
      if (skills.length >= 12) break;
    }
  }
  const roles = [];
  const exp = Array.isArray(resumeJson?.experience) ? resumeJson.experience : [];
  for (const job of exp.slice(0, 3)) {
    const co = String(job?.company || job?.employer || "").trim();
    const role = String(job?.title || job?.role || "").trim();
    const bullets = job?.bullets || job?.highlights || job?.achievements || [];
    const tip = Array.isArray(bullets) && bullets[0] ? String(bullets[0]).slice(0, 140) : "";
    roles.push(`${role || "Role"} @ ${co || "Company"}${tip ? ` — ${tip}` : ""}`);
  }
  return {
    name,
    title,
    years: years ? String(years) : "",
    skills: [...new Set(skills.map((s) => String(s).trim()).filter(Boolean))].slice(0, 12),
    recentRoles: roles
  };
}

/**
 * @param {{
 *   company?: string,
 *   title?: string,
 *   jdText?: string,
 *   contacts?: Array<object>,
 *   person?: object,
 *   resumeJson?: object|null
 * }} opts
 */
export function buildEmailComposePrompt(opts = {}) {
  const company = String(opts.company || "").trim() || "the company";
  const title = String(opts.title || "").trim() || "the open role";
  const jd = String(opts.jdText || "").trim().slice(0, 5000);
  const contacts = Array.isArray(opts.contacts) ? opts.contacts : [];
  const primary = pickPrimaryContact(contacts);
  const roleKind = classifyContactRole(primary?.role);
  const primaryName = String(primary?.name || "").trim() || "there";
  const primaryRole = String(primary?.role || "").trim() || roleKind;
  const resume = summarizeResumeForEmail(opts.resumeJson, opts.person || {});
  const contactLines = contacts
    .slice(0, 6)
    .map((c) => `- ${c.name || "?"} (${c.role || "?"}) <${c.email || ""}>`)
    .join("\n");

  return `Write one short hiring outreach email for this exact job. Tone: human, warm, professional — like a concise cover letter in email form (not a template blast).

JOB
- Company: ${company}
- Role: ${title}
- Primary recipient: ${primaryName} (${primaryRole}) — write as if emailing this person
- Recipient type: ${roleKind}

JD EXCERPT
"""
${jd || "(limited JD — lean on company + role + resume evidence)"}
"""

CANDIDATE (resume-grounded only)
- Name: ${resume.name || "Candidate"}
- Title: ${resume.title || "(see skills/roles)"}
- Years: ${resume.years || "n/a"}
- Skills: ${resume.skills.join(", ") || "(see roles)"}
- Recent work:
${resume.recentRoles.map((r) => `  • ${r}`).join("\n") || "  • (not provided)"}

OTHER CONTACTS (may be Cc'd — still personalize to the primary)
${contactLines || "(primary only)"}

RULES
1. Different for THIS job — reference 1–2 concrete JD needs and match them to resume evidence.
2. Do NOT invent tools, companies, metrics, or certifications that are not in the candidate summary.
3. Do NOT claim JD buzzwords absent from the resume.
4. End the body with a short closing greeting on its own line (e.g. "Warm regards,", "Thank you,", "Best regards,", or "Thanks,"). Do NOT add name, phone, LinkedIn, or any signature block after it — the mailbox signature handles that.
5. 120–220 words. Short paragraphs. Natural voice — avoid "I am writing to express my interest" and "I recently learned about the opportunity".
6. Subject line specific to this role/company (not generic "Application for…").
7. Greeting uses first name when available ("Hi ${primaryName.split(/\s+/)[0]},").

Output JSON only, no markdown fences:
{"subject":"","body":"","angle":"one-line note of what you personalized"}`;
}

/** Closings allowed at the end of Email Bid bodies (no name/phone after). */
export const EMAIL_BID_CLOSING_RE =
  /(?:Warm regards|Best regards|Kind regards|Thanks(?:\s+again)?|Thank you(?:\s+(?:so\s+much|again))?|Sincerely|Cheers)\s*,?\s*$/i;

const EMAIL_BID_CLOSINGS = ["Warm regards,", "Thank you,", "Best regards,", "Thanks,"];

/**
 * Keep a short closing line; strip name/phone/LinkedIn that often follow it.
 * @param {string} body
 * @param {string} [seed] varies which closing is appended when missing
 */
export function ensureEmailClosing(body, seed = "") {
  let text = String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(
      /\n((?:Warm regards|Best regards|Kind regards|Thanks|Thank you|Sincerely|Cheers),?)\s*\n(?:[^\n]*\n){0,6}\s*$/i,
      "\n$1"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return text;
  const tail = text.split(/\n/).slice(-2).join("\n");
  if (EMAIL_BID_CLOSING_RE.test(tail)) return text;
  let h = 0;
  for (const ch of String(seed || text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const closing = EMAIL_BID_CLOSINGS[h % EMAIL_BID_CLOSINGS.length];
  return `${text}\n\n${closing}`;
}

/**
 * @param {string} text
 * @returns {{ subject: string, body: string, angle?: string }|null}
 */
export function harvestEmailDraftFromAiText(text) {
  const raw = String(text || "");
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    const subject = String(parsed?.subject || "").trim();
    let body = String(parsed?.body || "").trim();
    if (subject.length < 4 || body.length < 40) return null;
    body = ensureEmailClosing(body, subject);
    return {
      subject: subject.slice(0, 180),
      body,
      angle: String(parsed?.angle || "").trim()
    };
  } catch {
    return null;
  }
}
