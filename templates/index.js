import { classicBlueTemplate } from "./classic-blue.js";
import { timesClassicTemplate } from "./times-classic.js";
import { oceanBlueClassicTemplate } from "./ocean-blue-classic.js";
import { navyTechnicalSerifTemplate } from "./navy-technical-serif.js";
import { US_MARKET_TEMPLATES } from "./us-market.js";
import {
  normalizeCerts,
  normalizeExperience,
  normalizeSkills,
  normalizeTechnicalSummary
} from "./shared.js";

/** Built-in resume PDF/HTML templates. Add new files here and register them. */
export const BUILTIN_TEMPLATES = [
  oceanBlueClassicTemplate,
  navyTechnicalSerifTemplate,
  classicBlueTemplate,
  timesClassicTemplate,
  ...US_MARKET_TEMPLATES
];

export const DEFAULT_TEMPLATE_ID = oceanBlueClassicTemplate.id;

export function getAllTemplates() {
  return BUILTIN_TEMPLATES;
}

export function getTemplateById(templateId) {
  return (
    BUILTIN_TEMPLATES.find((t) => t.id === templateId) ||
    BUILTIN_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ||
    BUILTIN_TEMPLATES[0]
  );
}

/**
 * True when the selected template renders a Technical Summary section, so the
 * generator should ask the model for `technical_summary`. Only opt-in templates
 * declare this; every other template ignores the field entirely.
 */
export function templateRequiresTechnicalSummary(templateId) {
  return getTemplateById(templateId)?.requiresTechnicalSummary === true;
}

/** Normalize resume JSON fields before rendering. */
export function normalizeResumeData(data) {
  if (!data || typeof data !== "object") return data || {};
  const technicalSummary = normalizeTechnicalSummary(
    data.technical_summary ?? data.technicalSummary
  );
  const normalized = {
    ...data,
    experience: normalizeExperience(data.experience),
    skills: normalizeSkills(data.skills),
    certifications: normalizeCerts(data.certifications),
    technical_summary: technicalSummary
  };
  // #region agent log
  fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "30a7bc" },
    body: JSON.stringify({
      sessionId: "30a7bc",
      runId: "pre-fix",
      hypothesisId: "C",
      location: "templates/index.js:normalizeResumeData",
      message: "Experience at render time",
      data: {
        entries: (normalized?.experience || []).map((j, i) => ({
          index: i,
          company: j?.company ?? null,
          employer: j?.employer ?? null,
          title: j?.title ?? null
        }))
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
  return normalized;
}

export function markHtmlForPdf(html) {
  const src = String(html || "");
  if (/data-ocean-pdf\s*=/i.test(src)) return src;
  if (/<html\b/i.test(src)) {
    return src.replace(/<html\b([^>]*)>/i, `<html data-ocean-pdf="1"$1>`);
  }
  return src;
}

/**
 * Render resume JSON to a full HTML document using the selected template.
 * Preview uses the screen card layout. Pass { forPdf: true } for the PDF pipeline.
 * @param {object} data - Parsed resume JSON
 * @param {string} [templateId] - Template id from BUILTIN_TEMPLATES
 * @param {{ forPdf?: boolean }} [options]
 */
export function resumeJsonToHtml(data, templateId, { forPdf = false } = {}) {
  const template = getTemplateById(templateId);
  const html = template.render(normalizeResumeData(data));
  return forPdf ? markHtmlForPdf(html) : html;
}
