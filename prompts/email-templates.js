/**
 * Hiring-focused roles + human cover-letter-style email templates.
 * Short closing greeting only (Warm regards / Thank you) — no name/phone block.
 * Multiple variants per role so jobs don't all sound the same.
 */

/** @typedef {"recruiter"|"hr"|"cto"|"hiring_manager"|"team_lead"|"unknown"} ContactRoleKind */

/**
 * @typedef {{ id: number, name: string, bestFor: string, variants: Array<{ subject: string, body: string }> }} EmailTemplateFamily
 */

/** @type {Record<number, EmailTemplateFamily>} */
export const EMAIL_TEMPLATES = {
  1: {
    id: 1,
    name: "Recruiter / TA",
    bestFor: "Recruiters and talent acquisition",
    variants: [
      {
        subject: "[Role Title] — [Your Name] (resume attached)",
        body: `Hi [Name],

I saw the [Role Title] opening at [Company] and wanted to reach out directly rather than only applying through the portal.

I've spent [number] years in [professional area], most recently deep in [skill 1] and [skill 2]. The JD's focus on [key requirement] matches work I've already done — for example, [short example showing ownership and impact].

Happy to jump on a quick call if useful. Resume is attached.

Warm regards,`
      },
      {
        subject: "Quick note on the [Role Title] role at [Company]",
        body: `Hi [Name],

Hoping to connect about the [Role Title] seat on your side.

My background is [professional area] ([number]+ years), with day-to-day strength in [skill 1], [skill 2], and [skill 3]. What stood out in the posting was [specific reason] — that's the kind of work I do best.

Resume attached if you'd like to take a look. Thanks either way.

Thank you,`
      },
      {
        subject: "[Your Name] for [Role Title] @ [Company]",
        body: `Hi [Name],

I'm applying for the [Role Title] role and wanted to put a short note with the resume.

At [current or recent company], I [brief technical achievement with an outcome]. That lines up with what you're asking for around [key requirement] and [requirement 2].

If there's a better fit on your reqs list, I'm open to that conversation too. Resume attached.

Best regards,`
      }
    ]
  },
  2: {
    id: 2,
    name: "HR focused",
    bestFor: "HR and people operations",
    variants: [
      {
        subject: "Interest in [Role Title] at [Company]",
        body: `Hi [Name],

I'm interested in the [Role Title] position at [Company] and wanted to introduce myself briefly.

My path has been [specialty or industry], especially [two relevant skills]. Recently at [current or recent company], I [relevant responsibility or achievement].

I've attached my resume and would welcome a short conversation if the timing is right.

Warm regards,`
      },
      {
        subject: "[Role Title] application — [Your Name]",
        body: `Hi [Name],

Sharing my resume for the [Role Title] opening.

What drew me in was [specific reason], plus the need for [key requirement] — both show up clearly in my recent work with [skill 1] and [skill 2].

Happy to answer any screening questions. Thanks for your time.

Thank you,`
      }
    ]
  },
  3: {
    id: 3,
    name: "CTO / technical leader",
    bestFor: "CTO, VP Engineering, technical director",
    variants: [
      {
        subject: "[Technical Title] interested in [Company]'s [Role Title]",
        body: `Hi [Name],

I'm reaching out about the [Role Title] role — less as a generic application, more because the technical shape of it fits how I work.

I've spent [number] years building and supporting [platforms, applications, or systems], with a core stack around [skill 1], [skill 2], and [skill 3]. Recently I [brief technical achievement with an outcome].

The posting's emphasis on [specific requirement] is exactly the kind of problem I like owning. Resume attached if you want the detail.

Best regards,`
      },
      {
        subject: "Re: [Role Title] — hands-on [Key Skill] background",
        body: `Hi [Name],

Quick note on the [Role Title] opening at [Company].

I'm a [Technical Title] with [number] years in the weeds on [skill 1] / [skill 2]. One recent example: [short example showing ownership and impact].

If your team is prioritizing [key requirement], I'd like to talk. Resume is attached.

Warm regards,`
      }
    ]
  },
  4: {
    id: 4,
    name: "Hiring manager",
    bestFor: "Manager responsible for the open role",
    variants: [
      {
        subject: "[Role Title] — experience with [Key Skill]",
        body: `Hi [Name],

I'm interested in joining your team as a [Role Title].

The posting calls out [requirement 1] and [requirement 2], which have been central in my recent work. At [company], I [relevant responsibility], including [specific task or result].

Resume attached — happy to walk through how I'd approach the first 90 days if useful.

Thank you,`
      },
      {
        subject: "Applying for your [Role Title] role",
        body: `Hi [Name],

Saw the [Role Title] opening and wanted to put my name in front of you with a bit more context than the portal form allows.

I've been doing [professional area] for [number] years, with recent focus on [skill 1] and [skill 2]. A concrete example: [short example showing ownership and impact].

Resume is attached. Would welcome a conversation about what success looks like on your team.

Best regards,`
      }
    ]
  },
  5: {
    id: 5,
    name: "Team lead",
    bestFor: "Team lead or delivery lead",
    variants: [
      {
        subject: "Interested in the [Role Title] on your team",
        body: `Hi [Name],

I'm interested in the [Role Title] opportunity on your team.

My background is [number] years in [field], focused on [specialty]. One strength I'd bring is [specific strength] — for example, I recently [short example showing ownership and impact].

Resume attached. Glad to chat about current priorities if you're open to it.

Warm regards,`
      },
      {
        subject: "[Your Name] — [Role Title] (resume)",
        body: `Hi [Name],

Reaching out about the [Role Title] role.

What caught my eye was [specific reason], especially the need for [key requirement]. That's close to work I just finished around [skill 1] / [skill 2].

I've attached my resume and would be happy to compare notes on how your team ships.

Thanks,`
      }
    ]
  }
};

/**
 * @param {string} role
 * @returns {ContactRoleKind}
 */
export function classifyContactRole(role) {
  const r = String(role || "").toLowerCase();
  if (/\brecruit|\btalent\b|\bta\b|\bstaffer|\bsourcing\b/.test(r)) return "recruiter";
  if (/\bhr\b|\bhuman resources|\bpeople ops|\bpeople partner|\bpeople operations/.test(r)) {
    return "hr";
  }
  if (/\bcto\b|\bchief technology|\bvp\s*eng|\bvice president.*eng|\bhead of eng|\bengineering director/.test(r)) {
    return "cto";
  }
  if (/\blead\b|\bteam lead|\btech lead|\bengineering manager|\bdelivery manager/.test(r)) {
    return "team_lead";
  }
  if (/\bhiring manager|\bmanager\b|\bdirector\b|\bhead of\b/.test(r)) return "hiring_manager";
  return "unknown";
}

/**
 * Prefer hiring-related contacts over executives.
 * @param {Array<object>} contacts
 */
export function pickPrimaryContact(contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  const rank = (c) => {
    const kind = classifyContactRole(c?.role);
    const order = { recruiter: 0, hr: 1, hiring_manager: 2, team_lead: 3, cto: 4, unknown: 5 };
    return (order[kind] ?? 5) - Number(c?.confidence || 0) * 0.1;
  };
  return [...list].sort((a, b) => rank(a) - rank(b))[0] || null;
}

/**
 * @param {ContactRoleKind|string} kind
 */
export function selectTemplateForRole(kind) {
  const k = String(kind || "");
  if (k === "recruiter") return EMAIL_TEMPLATES[1];
  if (k === "hr") return EMAIL_TEMPLATES[2];
  if (k === "cto") return EMAIL_TEMPLATES[3];
  if (k === "hiring_manager") return EMAIL_TEMPLATES[4];
  if (k === "team_lead") return EMAIL_TEMPLATES[5];
  return EMAIL_TEMPLATES[1];
}

/**
 * Stable per-job variant index so the same job stays consistent but different jobs diverge.
 * @param {EmailTemplateFamily} family
 * @param {{ company?: string, title?: string, jdText?: string }} job
 */
export function pickTemplateVariant(family, job = {}) {
  const variants = family?.variants || [];
  if (!variants.length) {
    return { subject: "Application", body: "Hi,\n\nPlease find my resume attached." };
  }
  const seed = `${job.company || ""}|${job.title || ""}|${String(job.jdText || "").slice(0, 240)}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return variants[h % variants.length];
}
