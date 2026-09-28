/**
 * Contact research prompt — hiring roles only (recruiter, HR, CTO, lead, HM).
 * Discover: name, email, role, phone (optional). Free deep-search friendly.
 */

export function buildEmailContactsPrompt({ company, title, jdLink, jdText, posterHint } = {}) {
  const co = String(company || "").trim() || "the company";
  const role = String(title || "").trim() || "the open role";
  const link = String(jdLink || "").trim();
  const jd = String(jdText || "").trim().slice(0, 6000);
  const poster = String(posterHint || "").trim();

  return `You are helping with targeted job outreach. Find hiring-related contacts only.

Company: ${co}
Role: ${role}
Job link: ${link || "(none)"}
Job poster hint: ${poster || "(none)"}
JD excerpt:
"""
${jd || "(not provided — use company + role + public web knowledge)"}
"""

TARGET ROLES (priority order — do NOT chase CEOs/founders unless no hiring contacts exist):
1. Recruiter / Talent Acquisition / job poster
2. HR / Recruiting Manager / People Ops
3. Hiring manager for this function
4. Team lead / Engineering manager / delivery lead
5. CTO / VP Engineering / relevant technical director (for engineering roles)

Deep search (when browsing / web search is available):
- Search the company website (contact, about, team, careers) and the job post for published emails.
- Prefer addresses that appear on public pages or in the JD — cite them by including the exact email.
- If browsing is unavailable, still return any emails already written in the JD / poster hint.

Rules:
- Return only these fields per contact: name, email, role, phone (phone only when publicly listed).
- Include every real email already written in the JD or job-poster hint (recruiter signature, "Email:" line). Do not drop those.
- Prefer publicly listed work emails. Never invent a random address or phone number.
- Do NOT invent first.last@company.com patterns. If you cannot verify a public email, omit that person.
- Return 3–6 best contacts max. If you cannot verify any email, return an empty list — do not stall or reply with punctuation.
- Always end with one JSON object (a short sentence before it is fine):

{"contacts":[{"name":"","email":"","role":"","phone":""}]}`;
}
