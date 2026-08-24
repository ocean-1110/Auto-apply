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

/**
 * Render resume JSON to a full HTML document using the selected template.
 * @param {object} data - Parsed resume JSON
 * @param {string} [templateId] - Template id from BUILTIN_TEMPLATES
 */
export function resumeJsonToHtml(data, templateId) {
  const template = getTemplateById(templateId);
  return template.render(normalizeResumeData(data));
}
