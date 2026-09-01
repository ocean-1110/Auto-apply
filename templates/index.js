import { classicBlueTemplate } from "./classic-blue.js";
import { timesClassicTemplate } from "./times-classic.js";
import { oceanBlueClassicTemplate } from "./ocean-blue-classic.js";
import { US_MARKET_TEMPLATES } from "./us-market.js";
import { normalizeCerts, normalizeSkills } from "./shared.js";

/** Built-in resume PDF/HTML templates. Add new files here and register them. */
export const BUILTIN_TEMPLATES = [
  oceanBlueClassicTemplate,
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

/** Normalize resume JSON fields before rendering. */
export function normalizeResumeData(data) {
  if (!data || typeof data !== "object") return data || {};
  return {
    ...data,
    skills: normalizeSkills(data.skills),
    certifications: normalizeCerts(data.certifications)
  };
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
