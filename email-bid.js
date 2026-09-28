/**
 * Email Bid — prepare (contacts + draft) then confirm send. Integrated UI path.
 */

import { buildEmailContactsPrompt } from "./prompts/email-contacts.js";
import {
  extractContactsFromJobText,
  harvestContactsFromAiText,
  mergeContacts
} from "./email-contacts.js";
import { discoverPublicCompanyContacts } from "./email-contact-find.js";
import { composeEmailBidSmart } from "./email-compose.js";
import { buildWebComposeUrl } from "./email-handoff.js";

const EMAIL_BID_CUSTOM_RESUME_KEY = "email_bid_custom_resume";

export async function reportEmailBidStatus(message, kind = "info", reportStatus) {
  const text = String(message || "").trim();
  if (!text) return;
  try {
    await chrome.storage.local.set({ generation_status: text });
  } catch {
    /* ignore */
  }
  if (typeof reportStatus === "function") {
    try {
      await reportStatus(text);
    } catch {
      /* ignore */
    }
  }
  if (kind === "ok" || kind === "err") {
    try {
      chrome.runtime
        .sendMessage({ type: "email_bid_toast", message: text, kind })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

/**
 * Find hiring contacts + compose draft (no send).
 */
export async function prepareEmailBidDraft(person, jobMeta, resumeJson, deps) {
  const company = String(jobMeta?.company || jobMeta?.companyName || "").trim();
  const title = String(jobMeta?.title || jobMeta?.jobTitle || "").trim();
  const label = company || title || "job";
  const from = String(person?.email || "").trim().toLowerCase();
  const status = (msg, kind = "info") => reportEmailBidStatus(msg, kind, deps.reportStatus);

  if (!from) {
    await status("Email Bid — set this profile's email in applicant info first", "err");
    return { ok: false, reason: "no-profile-email" };
  }
  if (typeof deps.runAiPrompt !== "function") {
    await status("Email Bid — AI helper unavailable", "err");
    return { ok: false, reason: "no-ai" };
  }

  await status(`Email Bid · finding hiring contacts for ${label}…`);

  const contactPrompt = buildEmailContactsPrompt({
    company,
    title,
    jdLink: jobMeta?.jdLink || "",
    jdText: jobMeta?.jdText || jobMeta?.description || "",
    posterHint: jobMeta?.posterHint || jobMeta?.poster || ""
  });

  const jobBlob = [
    jobMeta?.jdText || jobMeta?.description || "",
    jobMeta?.posterHint || jobMeta?.poster || ""
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n");
  const fromJob = extractContactsFromJobText(jobBlob, { role: title });

  await status(`Email Bid · scanning public company pages for ${label}…`);
  let fromPages = [];
  try {
    fromPages = await discoverPublicCompanyContacts({
      company,
      jdLink: jobMeta?.jdLink || "",
      jdText: jobBlob,
      title,
      timeoutMs: 10000,
      fetchImpl: typeof deps.fetchImpl === "function" ? deps.fetchImpl : undefined
    });
  } catch {
    fromPages = [];
  }

  let aiContacts = [];
  try {
    await status(`Email Bid · AI contact search for ${label}…`);
    const aiText = await deps.runAiPrompt(contactPrompt, {
      statusLabel: "Email Bid · contacts",
      expectJson: true
    });
    aiContacts = harvestContactsFromAiText(aiText, { company });
  } catch (err) {
    if (!fromJob.length && !fromPages.length) {
      await status(
        `Email Bid contacts failed — ${String(err?.message || err).slice(0, 80)}`,
        "err"
      );
      return { ok: false, reason: "contacts-failed", error: String(err?.message || err) };
    }
    await status(
      "Email Bid · AI contact search failed — using JD / company-site emails.",
      "info"
    );
  }

  const contacts = mergeContacts(fromJob, fromPages, aiContacts);
  const sourceNote = `JD ${fromJob.length} · site ${fromPages.length} · AI ${aiContacts.length}`;
  await status(`Email Bid · contacts ${sourceNote}`);

  if (!contacts.length) {
    await status(`Email Bid — no hiring contacts found for ${label}`, "info");
    return { ok: false, reason: "no-contacts", contacts: [] };
  }

  await status(`Email Bid · drafting a human note for ${label}…`);
  const composed = await composeEmailBidSmart({
    contacts,
    person,
    job: { title, company, jdText: jobMeta?.jdText || jobMeta?.description || "" },
    resumeJson,
    runAiPrompt: deps.runAiPrompt
  });

  await status(
    `Email Bid draft ready — review To (${composed.toEmails.length}) then Confirm & Send · ${sourceNote}`,
    "info"
  );

  return {
    ok: true,
    from,
    contacts,
    toEmails: composed.toEmails,
    subject: composed.subject,
    body: composed.body,
    templateId: composed.templateId,
    templateName: composed.templateName,
    roleKind: composed.roleKind,
    primaryName: composed.primaryName,
    source: composed.source || "local",
    contactSources: {
      jd: fromJob.length,
      site: fromPages.length,
      ai: aiContacts.length
    }
  };
}

export async function resolveEmailBidAttachments(person, jobMeta, deps = {}) {
  const store = await chrome.storage.local.get([EMAIL_BID_CUSTOM_RESUME_KEY]);
  const custom = store[EMAIL_BID_CUSTOM_RESUME_KEY] || null;
  const hasCustom =
    custom &&
    custom.base64 &&
    (!custom.profileId || custom.profileId === person?.id);

  /** @type {Array<{ fileName: string, mimeType?: string, base64: string, kind: string }>} */
  const attachments = [];

  if (hasCustom) {
    attachments.push({
      fileName: custom.fileName || "Resume.pdf",
      mimeType: custom.mimeType || "application/pdf",
      base64: custom.base64,
      kind: "resume"
    });
  } else if (typeof deps.resolveResumeAttachment === "function") {
    try {
      const resumeAtt = await deps.resolveResumeAttachment({ person, jobMeta });
      if (resumeAtt?.base64) {
        attachments.push({
          fileName: resumeAtt.fileName || "Resume.pdf",
          mimeType: resumeAtt.mimeType || "application/pdf",
          base64: resumeAtt.base64,
          kind: "resume"
        });
      }
    } catch {
      /* soft */
    }
  }

  if (deps.attachCover !== false && typeof deps.resolveCoverAttachment === "function") {
    try {
      const cover = await deps.resolveCoverAttachment({ person, jobMeta });
      if (cover?.base64) {
        attachments.push({
          fileName: cover.fileName || "Cover Letter.pdf",
          mimeType: cover.mimeType || "application/pdf",
          base64: cover.base64,
          kind: "cover"
        });
      }
    } catch {
      /* soft */
    }
  }

  return attachments;
}

export async function sendConfirmedEmailBid(person, draft, deps = {}) {
  const from = String(person?.email || "").trim().toLowerCase();
  const toEmails = (draft.toEmails || [])
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);
  const subject = String(draft.subject || "").trim();
  const body = String(draft.body || "").trim();
  const jobMeta = draft.jobMeta || {};
  const label = String(
    jobMeta.company || jobMeta.companyName || jobMeta.title || jobMeta.jobTitle || "job"
  ).trim();
  const status = (msg, kind = "info") => reportEmailBidStatus(msg, kind, deps.reportStatus);

  if (!from) {
    await status("Email Bid — set this profile's email in applicant info first", "err");
    return { ok: false, reason: "no-profile-email" };
  }
  if (!toEmails.length) {
    await status("Email Bid — select at least one recipient", "err");
    return { ok: false, reason: "no-recipients" };
  }
  if (!subject || !body) {
    await status("Email Bid — subject and body required", "err");
    return { ok: false, reason: "empty-message" };
  }

  const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
  const composeUrl = buildWebComposeUrl(from, { to: toEmails, subject, body });
  await status(`Email Bid · opening mail for ${toEmails.length} recipient(s)…`);

  try {
    if (typeof deps.openWebCompose !== "function") {
      throw new Error("Mail handoff is unavailable.");
    }
    await deps.openWebCompose({
      url: composeUrl,
      from,
      to: toEmails,
      subject,
      body,
      attachments
    });
  } catch (err) {
    await status(`Email Bid failed — ${String(err?.message || err).slice(0, 100)}`, "err");
    return { ok: false, error: String(err?.message || err) };
  }

  if (!attachments.length) {
    await status("Email Bid · attach the latest resume PDF in the mail window before you send.", "info");
  }

  // Sheet only after a successful send — Applied upsert (no pre-send Ready row).
  let sheetNote = "";
  if (deps.writeSheet !== false) {
    const record =
      typeof deps.recordSheetApplied === "function"
        ? deps.recordSheetApplied
        : typeof deps.markSheetApplied === "function"
          ? deps.markSheetApplied
          : null;
    if (record) {
      try {
        const sheetResult = await record(jobMeta);
        if (sheetResult?.skipped && sheetResult?.reason === "no-sheet") {
          sheetNote = " (sheet not configured)";
        } else if (sheetResult?.ok === false) {
          sheetNote = ` (sheet: ${String(sheetResult.error || sheetResult.reason || "failed").slice(0, 80)})`;
          await status(
            `Email Bid opened — sheet update failed: ${String(
              sheetResult.error || sheetResult.reason || "unknown"
            ).slice(0, 100)}`,
            "err"
          );
        } else if (sheetResult?.appended) {
          sheetNote = " · sheet Applied (new row)";
        } else if (sheetResult?.updated) {
          sheetNote = " · sheet Applied";
        } else if (sheetResult?.ok !== false) {
          sheetNote = " · sheet Applied";
        }
      } catch (err) {
        sheetNote = ` (sheet: ${String(err?.message || err).slice(0, 80)})`;
        await status(
          `Email Bid opened — sheet update failed: ${String(err?.message || err).slice(0, 100)}`,
          "err"
        );
      }
    }
  }

  await status(
    `Email Bid opened in mail — ${label} (${toEmails.length} recipients). Send it there.${sheetNote}`,
    "ok"
  );
  return {
    ok: true,
    handoff: true,
    composeUrl,
    toEmails,
    subject,
    from,
    statusMessage: `Email Bid opened in mail — ${label} (${toEmails.length} recipients).${sheetNote}`
  };
}
