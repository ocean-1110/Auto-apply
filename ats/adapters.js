/**
 * Thin ATS adapter registry — site identity, auto-submit policy, and step budgets.
 * DOM fill stays in content/autofill.js; adapters only encode host quirks the SW needs.
 */

/**
 * @typedef {object} AtsAdapter
 * @property {string} id
 * @property {string} label
 * @property {RegExp[]} hostPatterns
 * @property {boolean} autoSubmitAllowed
 * @property {boolean} [alwaysAutoSubmit]
 * @property {boolean} [isEmployerAts]
 * @property {boolean} [isGateway]
 * @property {number} [stepBudget]
 * @property {boolean} [emailOtp]
 * @property {boolean} [aiFormAssist] When false, Apply uses rule-based fill only (no form plan / button AI).
 */

/** @type {AtsAdapter[]} */
export const ATS_ADAPTERS = [
  {
    id: "dice",
    label: "Dice",
    hostPatterns: [/(^|\.)dice\.com$/i],
    autoSubmitAllowed: true,
    // Dice Easy Apply is profile + upload + Next/Submit; AI form planning slows/breaks it.
    aiFormAssist: false,
    stepBudget: 12
  },
  {
    id: "indeed",
    label: "Indeed",
    hostPatterns: [/(^|\.)indeed\.com$/i],
    autoSubmitAllowed: false,
    stepBudget: 12
  },
  {
    id: "workday",
    label: "Workday",
    hostPatterns: [/(^|\.)myworkdayjobs\.com$/i, /(^|\.)workdayjobs\.com$/i],
    autoSubmitAllowed: false,
    isEmployerAts: true,
    stepBudget: 16
  },
  {
    id: "greenhouse",
    label: "Greenhouse",
    hostPatterns: [/(^|\.)greenhouse\.io$/i],
    autoSubmitAllowed: false,
    isEmployerAts: true,
    stepBudget: 18,
    emailOtp: true
  },
  {
    id: "jobright",
    label: "Jobright",
    hostPatterns: [/(^|\.)jobright\.ai$/i],
    autoSubmitAllowed: false,
    isGateway: true,
    stepBudget: 16
  },
  {
    id: "jobgether",
    label: "Jobgether",
    hostPatterns: [/(^|\.)jobgether\.com$/i],
    autoSubmitAllowed: false,
    isGateway: true,
    stepBudget: 18
  },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    hostPatterns: [/(^|\.)smartrecruiters\.com$/i],
    autoSubmitAllowed: false,
    isEmployerAts: true,
    stepBudget: 16
  },
  {
    id: "zohorecruit",
    label: "Zoho Recruit",
    hostPatterns: [
      /(^|\.)zohorecruit\.com$/i,
      /(^|\.)recruit\.zoho\.com$/i,
      /(^|\.)recruit\.zoho\.eu$/i,
      /(^|\.)recruit\.zoho\.in$/i
    ],
    autoSubmitAllowed: false,
    isEmployerAts: true,
    stepBudget: 16
  },
  {
    id: "oraclecloud",
    label: "Oracle Cloud",
    hostPatterns: [/(^|\.)oraclecloud\.com$/i],
    autoSubmitAllowed: false,
    isEmployerAts: true,
    stepBudget: 16
  }
];

const BY_ID = new Map(ATS_ADAPTERS.map((a) => [a.id, a]));

export function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname || "";
  } catch {
    return "";
  }
}

/**
 * @param {string} url
 * @returns {AtsAdapter | null}
 */
export function matchAdapter(url) {
  const host = hostnameFromUrl(url).toLowerCase();
  if (!host) return null;
  for (const adapter of ATS_ADAPTERS) {
    if (adapter.hostPatterns.some((re) => re.test(host))) return adapter;
  }
  return null;
}

/**
 * @param {string} url
 * @returns {string} adapter id or "generic"
 */
export function applySiteFromUrl(url) {
  return matchAdapter(url)?.id || "generic";
}

/**
 * @param {string} site
 * @returns {AtsAdapter | null}
 */
export function getAdapter(site) {
  return BY_ID.get(String(site || "")) || null;
}

export function applySiteLabel(site) {
  return getAdapter(site)?.label || "application";
}

export function isEmployerAtsSite(site) {
  return Boolean(getAdapter(site)?.isEmployerAts);
}

export function isAutoSubmitAllowedSite(site) {
  return Boolean(getAdapter(site)?.autoSubmitAllowed);
}

/**
 * Whether Auto Apply may call OpenAI for whole-form planning, per-field answers,
 * or button picking. Dice stays rule-based so scrape/apply can finish end-to-end.
 * @param {string} site
 */
export function isAiFormAssistAllowed(site) {
  const adapter = getAdapter(site);
  if (!adapter) return true;
  return adapter.aiFormAssist !== false;
}

/**
 * Gateway sites (Jobright, Jobgether) list jobs but hand the actual application
 * off to an employer ATS — usually in a new tab. Orchestration uses this to
 * follow that redirect instead of trying to fill the listing page.
 * @param {string} site
 */
export function isGatewaySite(site) {
  return Boolean(getAdapter(site)?.isGateway);
}

/**
 * Resolve whether this apply run should click Submit.
 * Dice auto-clicks Submit. Other ATS stop on the Submit page so you can
 * review the filled fields, then click Submit in the Ocean panel.
 * @param {string} site
 * @param {boolean} autoSubmitCaller
 */
export function resolveEffectiveAutoSubmit(site, autoSubmitCaller = false) {
  const adapter = getAdapter(site);
  if (!adapter?.autoSubmitAllowed) return false;
  return Boolean(autoSubmitCaller) || Boolean(adapter.alwaysAutoSubmit);
}

export function stepBudgetForSite(site, maxSteps = 12) {
  const budget = getAdapter(site)?.stepBudget;
  return Math.max(Number(maxSteps) || 12, Number(budget) || 12);
}

export function isEmployerAtsHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return ATS_ADAPTERS.some(
    (a) => a.isEmployerAts && a.hostPatterns.some((re) => re.test(host))
  );
}

export function isUrlOnApplySite(url, site) {
  return site !== "generic" && applySiteFromUrl(url) === site;
}
