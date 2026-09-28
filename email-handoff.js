/**
 * Outlook / Gmail web compose. Ocean does not send mail itself.
 * The user reviews the draft and clicks Send in their own mailbox.
 */

export function mailProviderForEmail(email) {
  const domain = String(email || "")
    .trim()
    .toLowerCase()
    .split("@")[1] || "";
  if (!domain) return "unknown";
  if (domain === "gmail.com" || domain === "googlemail.com") return "gmail";
  if (
    domain === "outlook.com" ||
    domain === "hotmail.com" ||
    domain === "live.com" ||
    domain === "msn.com" ||
    domain.endsWith(".onmicrosoft.com") ||
    domain.endsWith(".outlook.com")
  ) {
    return "outlook";
  }
  return "unknown";
}

/**
 * HTTPS compose URL. encodeURIComponent keeps spaces as %20 (Outlook Live
 * shows a literal + when URLSearchParams is used).
 * @param {string} fromEmail
 * @param {{ to?: string[], subject?: string, body?: string }} opts
 */
export function buildWebComposeUrl(fromEmail, opts = {}) {
  const to = (opts.to || []).map((e) => String(e).trim()).filter(Boolean).join(",");
  const subject = String(opts.subject || "");
  const body = String(opts.body || "").slice(0, 1800);
  const provider = mailProviderForEmail(fromEmail);
  const q = [];
  if (provider === "gmail") {
    q.push("view=cm", "fs=1");
    if (to) q.push(`to=${encodeURIComponent(to)}`);
    if (subject) q.push(`su=${encodeURIComponent(subject)}`);
    if (body) q.push(`body=${encodeURIComponent(body)}`);
    return `https://mail.google.com/mail/?${q.join("&")}`;
  }
  if (provider === "outlook") {
    if (to) q.push(`to=${encodeURIComponent(to)}`);
    if (subject) q.push(`subject=${encodeURIComponent(subject)}`);
    if (body) q.push(`body=${encodeURIComponent(body)}`);
    return `https://outlook.live.com/mail/0/deeplink/compose?${q.join("&")}`;
  }
  const mailto = [`mailto:${encodeURIComponent(to)}`];
  const mq = [];
  if (subject) mq.push(`subject=${encodeURIComponent(subject)}`);
  if (body) mq.push(`body=${encodeURIComponent(body)}`);
  return mq.length ? `${mailto[0]}?${mq.join("&")}` : mailto[0];
}
