/**
 * Fill human-style templates from profile + JD + resume.
 * Short closing greeting only — mailbox signature adds name/phone.
 */

import {
  EMAIL_TEMPLATES,
  classifyContactRole,
  pickPrimaryContact,
  selectTemplateForRole,
  pickTemplateVariant
} from "./prompts/email-templates.js";
import {
  buildEmailComposePrompt,
  ensureEmailClosing,
  harvestEmailDraftFromAiText
} from "./prompts/email-compose.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Prefer skills that appear in the JD when they also appear on the resume.
 */
export function pickSkills(resumeJson, jdText = "", limit = 3) {
  const skills = [];
  const raw = resumeJson?.skills;
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (typeof s === "string") skills.push(clean(s));
      else if (s && typeof s === "object") {
        const items = s.items || s.skills || s.list;
        if (Array.isArray(items)) skills.push(...items.map(clean));
        else if (s.name) skills.push(clean(s.name));
      }
    }
  }
  const unique = [...new Set(skills.filter(Boolean))];
  const jd = String(jdText || "").toLowerCase();
  const jdMatched = unique.filter((s) => jd.includes(String(s).toLowerCase()));
  const ordered = [...jdMatched, ...unique.filter((s) => !jdMatched.includes(s))];
  if (ordered.length >= 2) return ordered.slice(0, limit);

  const jdBits = String(jdText || "").match(
    /\b(Salesforce|Lightning|Apex|React|Python|Java|AWS|Azure|Kubernetes|SQL|Node\.?js|TypeScript|DevOps|CI\/CD|Snowflake|dbt)\b/gi
  );
  if (jdBits) {
    for (const bit of jdBits.map(clean)) {
      if (!ordered.includes(bit)) ordered.push(bit);
    }
  }
  return [...new Set(ordered)].slice(0, limit);
}

export function pickRecentEmployer(resumeJson, person = {}) {
  const exp = resumeJson?.experience;
  if (Array.isArray(exp) && exp[0]) {
    return clean(exp[0].company || exp[0].employer || exp[0].name) || clean(person.currentCompany);
  }
  return clean(person.currentCompany) || "my recent role";
}

export function pickAchievement(resumeJson, jdText = "") {
  const exp = resumeJson?.experience;
  const jd = String(jdText || "").toLowerCase();
  if (Array.isArray(exp)) {
    let fallback = "";
    for (const job of exp) {
      const bullets = job?.bullets || job?.highlights || job?.achievements;
      if (!Array.isArray(bullets)) continue;
      for (const b of bullets) {
        const line = clean(b).slice(0, 180);
        if (!line) continue;
        if (!fallback) fallback = line;
        if (jd && line.toLowerCase().split(/\W+/).some((w) => w.length > 4 && jd.includes(w))) {
          return line;
        }
      }
    }
    if (fallback) return fallback;
  }
  return "shipping reliable delivery on complex projects";
}

export function pickCompanyReason(jdText, company) {
  const text = String(jdText || "");
  const m = text.match(
    /(?:about\s+(?:us|the\s+company)|our\s+mission|we\s+(?:are|build|help))[:\s]+([^\n.]{20,120})/i
  );
  if (m) return clean(m[1]);
  const product = text.match(
    /\b(?:platform|product|customers?|clients?|healthcare|fintech|saas|cloud|data)\b[^\n.]{0,80}/i
  );
  if (product) return clean(product[0]).slice(0, 100);
  if (company) return `the problems ${company} is solving in this space`;
  return "the team's product focus";
}

export function pickKeyRequirement(jdText, skills = []) {
  const text = String(jdText || "");
  const m = text.match(
    /(?:requirements?|qualifications?|must\s*have|you(?:'ll| will)\s+(?:need|bring))[:\s]+([^\n]{12,110})/i
  );
  if (m) return clean(m[1]).replace(/^[•\-\d.)\s]+/, "").slice(0, 100);
  if (skills[0]) return skills[0];
  return "the core skills listed in the role";
}

export function pickYears(person = {}, resumeJson = null) {
  const fromPerson = Number(person.yearsExperience || person.years);
  if (Number.isFinite(fromPerson) && fromPerson > 0) return String(Math.round(fromPerson));
  const exp = resumeJson?.experience;
  if (Array.isArray(exp) && exp.length) return String(Math.min(20, Math.max(3, exp.length * 2 + 2)));
  return "several";
}

function personDisplayName(person = {}) {
  return (
    clean(person.name || person.fullName) ||
    clean([person.firstName, person.lastName].filter(Boolean).join(" ")) ||
    "Candidate"
  );
}

/**
 * Local fallback compose (variant picked from job seed).
 * @param {{
 *   contacts?: Array<object>,
 *   person?: object,
 *   job?: { title?: string, company?: string, jdText?: string },
 *   resumeJson?: object|null,
 *   templateId?: number
 * }} opts
 */
export function composeEmailBid(opts = {}) {
  const contacts = Array.isArray(opts.contacts) ? opts.contacts : [];
  const person = opts.person || {};
  const job = opts.job || {};
  const resumeJson = opts.resumeJson || null;

  const primary = pickPrimaryContact(contacts);
  const kind = classifyContactRole(primary?.role);
  const family =
    (opts.templateId && EMAIL_TEMPLATES[opts.templateId]) || selectTemplateForRole(kind);
  const variant = pickTemplateVariant(family, job);

  const skills = pickSkills(resumeJson, job.jdText, 3);
  const title = clean(job.title) || clean(person.title) || "the open role";
  const company = clean(job.company) || "your company";
  const yourName = personDisplayName(person);
  const greetingName = clean(primary?.name)?.split(/\s+/)[0] || "there";
  const specialty = clean(person.headline || person.trackLabel || skills[0]) || "software engineering";
  const recentCompany = pickRecentEmployer(resumeJson, person);
  const achievement = pickAchievement(resumeJson, job.jdText);
  const companyReason = pickCompanyReason(job.jdText, company);
  const keyReq = pickKeyRequirement(job.jdText, skills);
  const years = pickYears(person, resumeJson);
  const proTitle = clean(person.title || resumeJson?.headline) || title;

  /** @type {Record<string, string>} */
  const map = {
    "[Name]": greetingName,
    "[Role Title]": title,
    "[Company]": company,
    "[Your Name]": yourName,
    "[specialty or industry]": specialty,
    "[two relevant skills]": skills.slice(0, 2).join(" and ") || specialty,
    "[current or recent company]": recentCompany,
    "[relevant responsibility or achievement]": achievement,
    "[specific product, mission, project, or business area]": companyReason,
    "[number]": years,
    "[professional area]": specialty,
    "[skill 1]": skills[0] || specialty,
    "[skill 2]": skills[1] || skills[0] || "delivery",
    "[skill 3]": skills[2] || skills[1] || "collaboration",
    "[key requirement]": keyReq,
    "[specific reason]": companyReason,
    "[Technical Title]": proTitle,
    "[platforms, applications, or systems]": skills[0] ? `${skills[0]} systems` : "modern platforms",
    "[brief technical achievement with an outcome]": achievement,
    "[specific requirement]": keyReq,
    "[Key Skill]": skills[0] || specialty,
    "[requirement 1]": skills[0] || keyReq,
    "[requirement 2]": skills[1] || keyReq || "cross-team delivery",
    "[company]": recentCompany,
    "[relevant responsibility]": achievement,
    "[specific task or result]": achievement,
    "[Team Name]": company,
    "[field]": specialty,
    "[specialty]": specialty,
    "[specific strength]": skills[0] || "ownership of end-to-end delivery",
    "[short example showing ownership and impact]": achievement
  };

  let subject = variant.subject;
  let body = variant.body;
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    subject = subject.split(key).join(map[key]);
    body = body.split(key).join(map[key]);
  }
  subject = subject.replace(/\[[^\]]+\]/g, "").replace(/\s{2,}/g, " ").trim();
  body = ensureEmailClosing(
    body.replace(/\[[^\]]+\]/g, "").replace(/\n{3,}/g, "\n\n").trim(),
    `${subject}|${company}|${title}`
  );

  const toEmails = [
    ...new Set(
      contacts
        .map((c) => clean(c.email).toLowerCase())
        .filter((e) => EMAIL_RE.test(e))
    )
  ].slice(0, 8);

  return {
    templateId: family.id,
    templateName: family.name,
    roleKind: kind,
    primaryName: greetingName,
    subject,
    body,
    toEmails,
    source: "local"
  };
}

/**
 * Try AI personalized draft; fall back to local variants.
 * @param {object} opts same as composeEmailBid plus runAiPrompt
 */
export async function composeEmailBidSmart(opts = {}) {
  const local = composeEmailBid(opts);
  if (typeof opts.runAiPrompt !== "function") return local;

  try {
    const prompt = buildEmailComposePrompt({
      company: opts.job?.company,
      title: opts.job?.title,
      jdText: opts.job?.jdText,
      contacts: opts.contacts,
      person: opts.person,
      resumeJson: opts.resumeJson
    });
    const aiText = await opts.runAiPrompt(prompt, {
      statusLabel: "Email Bid · draft",
      expectJson: true,
      harvest: "draft"
    });
    const draft = harvestEmailDraftFromAiText(aiText);
    if (draft?.subject && draft?.body) {
      return {
        ...local,
        subject: draft.subject,
        body: draft.body,
        templateName: `${local.templateName} (AI)`,
        source: "ai",
        angle: draft.angle || ""
      };
    }
  } catch {
    /* soft fallback */
  }
  return local;
}

export { EMAIL_RE, buildEmailComposePrompt, harvestEmailDraftFromAiText };
