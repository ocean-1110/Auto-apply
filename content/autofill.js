/**
 * Generic application-form autofill (content script).
 * Fills text, textarea, select, checkbox, and radio controls from applicant info.
 * For dropdowns/comboboxes: never types "yes"/"no" — opens the list and picks a matching option.
 */
(function resumeBotAutofill() {
  // Keyed by build, not a plain boolean: a tab that already ran an older copy of
  // this script would otherwise block the updated one from installing.
  const SCRIPT_BUILD = "2026-08-26.dice-apply-not-profile.1";
  if (window.__resumeBotAutofillBuild === SCRIPT_BUILD) return;
  window.__resumeBotAutofillBuild = SCRIPT_BUILD;
  window.__resumeBotAutofillInstalled = true;

  // Learn mode: capture answers the user types/selects. Suppressed briefly while
  // the extension autofills so we never re-store our own programmatic values.
  let learnEnabled = true;
  let learnSuppressUntil = 0;
  const learnSentByQuestion = new Map();
  function suppressLearn(ms = 2500) {
    learnSuppressUntil = Date.now() + ms;
  }

  const FIELD_ALIASES = {
    firstName: ["first name", "firstname", "given name", "legal first name"],
    lastName: [
      "last name",
      "lastname",
      "surname",
      "family name",
      "legal last name",
      "preferred last name"
    ],
    middleName: ["middle name", "middle initial", "mi"],
    preferredName: ["preferred name", "preferred first name", "nickname", "what should we call you"],
    email: ["email", "e-mail", "email address", "work email"],
    phone: ["phone number", "mobile phone", "cell phone", "telephone number", "primary phone"],
    phoneDeviceType: ["phone device type", "device type"],
    phoneCountryCode: ["country phone code", "phone country code", "country code"],
    country: ["country", "country/region"],
    addressLine1: ["address line 1", "street address", "address 1", "home address", "street"],
    addressLine2: ["address line 2", "address 2", "apartment", "suite", "unit", "apt"],
    city: ["city", "town", "municipality"],
    state: ["state", "province", "state/province"],
    zipCode: ["zip", "zip code", "postal", "postal code", "zip/postal", "post code"],
    cityCountryOfResidence: [
      "city, country of residence",
      "city country of residence",
      "city and country of residence",
      "country of residence"
    ],

    workAuthorized: [
      "eligible to work in the united states",
      "eligible to work in the us",
      "eligible to work",
      "authorized to work in the united states",
      "authorized to work in the us",
      "authorized to work",
      "legally authorized",
      "legally authorized to work",
      "work authorization",
      "right to work",
      "legally entitled to work"
    ],
    needsSponsorship: [
      "require sponsorship or assistance",
      "require sponsorship",
      "visa sponsorship",
      "need sponsorship",
      "will you now or in the future require",
      "maintain work eligibility",
      "sponsorship or assistance"
    ],
    postEmploymentRestrictions: [
      "continuing employment restrictions",
      "employment restrictions or obligations",
      "restrictions or obligations with your current or former employer",
      "non-solicitation",
      "non solicitation",
      "non-competition",
      "non competition",
      "non-compete",
      "non compete",
      "post-employment",
      "post employment",
      "restrictive covenant",
      "subject to any contract"
    ],
    workedForCompanyBefore: [
      "worked for",
      "worked at",
      "employed by",
      "previously employed",
      "worked in the past",
      "any subsidiary"
    ],
    relatedToEmployee: [
      "closely related",
      "close personal relationship",
      "personal relationship with anyone who currently works",
      "related to anyone who works"
    ],
    governmentEmployee: [
      "current or former government employee",
      "government employee",
      "federal national state local or military"
    ],
    governmentEthicsRecusal: [
      "notified your ethics official",
      "recused yourself",
      "ethics official and recused"
    ],
    willingToRelocate: ["relocate", "willing to relocate", "relocation"],
    over18: ["over 18", "at least 18", "18 years of age", "age of majority"],
    felonyConviction: ["felony", "criminal conviction", "convicted of a crime", "criminal record"],
    felonyExplanation: ["please explain", "conviction explanation", "explain your"],

    yearsExperience: ["years of experience", "total experience", "years experience", "how many years"],
    relevantExperience: ["relevant experience", "describe your experience"],
    englishLevel: [
      "english level",
      "english proficiency",
      "level of english",
      "language proficiency",
      "fluency in english"
    ],
    linkedinUrl: [
      "linkedin",
      "linkedin url",
      "linkedin profile",
      "linkedin profile link",
      "linkedin profile url",
      "linkedin link"
    ],
    portfolioUrl: ["portfolio", "website", "personal website", "portfolio url"],
    githubUrl: ["github", "github url", "github profile"],

    highestDegree: ["highest degree", "degree", "education level", "highest level of education"],
    schoolName: ["school", "university", "college", "institution", "school name"],
    fieldOfStudy: ["field of study", "major", "concentration", "area of study"],
    graduationDate: [
      "graduation",
      "graduation date",
      "date graduated",
      "graduated",
      "graduation year"
    ],

    whyInterested: [
      "why are you interested",
      "why do you want",
      "why this role",
      "why this company",
      "cover letter",
      "additional information",
      "anything else"
    ],
    salaryExpectation: [
      "salary",
      "compensation",
      "expected salary",
      "salary expectations",
      "desired salary",
      "pay expectation"
    ],
    earliestStartDate: ["start date", "earliest start", "available to start", "when can you start"],
    backgroundCheckConsent: ["background check", "background screening"],
    drugTestConsent: ["drug test", "drug screen", "drug screening"],

    gender: ["gender", "gender identity", "sex"],
    hispanicLatino: [
      "hispanic/latino",
      "hispanic or latino",
      "are you hispanic",
      "hispanic latino",
      "latinx"
    ],
    raceEthnicity: [
      "identify your race",
      "please identify your race",
      "racial/ethnic background",
      "race/ethnicity",
      "race ethnicity",
      "racial background",
      "ethnicity",
      "race"
    ],
    veteranStatus: ["veteran", "military status", "protected veteran", "armed forces"],
    disabilityStatus: ["disability", "disabled", "chronic condition"]
  };

  /** Prefer matching on the direct field label, not section headers like "Address". */
  const FIELD_MATCH_ORDER = [
    "addressLine2",
    "addressLine1",
    "city",
    "state",
    "zipCode",
    "cityCountryOfResidence",
    "phoneCountryCode",
    "phoneDeviceType",
    "phone",
    "firstName",
    "lastName",
    "middleName",
    "preferredName",
    "email",
    "country",
    "workAuthorized",
    "needsSponsorship",
    "postEmploymentRestrictions",
    "workedForCompanyBefore",
    "relatedToEmployee",
    "governmentEmployee",
    "governmentEthicsRecusal",
    "willingToRelocate",
    "over18",
    "felonyConviction",
    "felonyExplanation",
    "yearsExperience",
    "relevantExperience",
    "englishLevel",
    "linkedinUrl",
    "portfolioUrl",
    "githubUrl",
    "highestDegree",
    "schoolName",
    "fieldOfStudy",
    "graduationDate",
    "salaryExpectation",
    "earliestStartDate",
    "whyInterested",
    "gender",
    "hispanicLatino",
    "raceEthnicity",
    "veteranStatus",
    "disabilityStatus",
    "backgroundCheckConsent",
    "drugTestConsent"
  ];

  const AUTOCOMPLETE_FIELD_MAP = {
    "given-name": "firstName",
    "family-name": "lastName",
    "additional-name": "middleName",
    nickname: "preferredName",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    "tel-local": "phone",
    "street-address": "addressLine1",
    "address-line1": "addressLine1",
    "address-line2": "addressLine2",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "zipCode",
    "country-name": "country",
    country: "country"
  };

  const US_STATE_LABELS = {
    AL: "Alabama",
    AK: "Alaska",
    AZ: "Arizona",
    AR: "Arkansas",
    CA: "California",
    CO: "Colorado",
    CT: "Connecticut",
    DE: "Delaware",
    DC: "District of Columbia",
    FL: "Florida",
    GA: "Georgia",
    HI: "Hawaii",
    ID: "Idaho",
    IL: "Illinois",
    IN: "Indiana",
    IA: "Iowa",
    KS: "Kansas",
    KY: "Kentucky",
    LA: "Louisiana",
    ME: "Maine",
    MD: "Maryland",
    MA: "Massachusetts",
    MI: "Michigan",
    MN: "Minnesota",
    MS: "Mississippi",
    MO: "Missouri",
    MT: "Montana",
    NE: "Nebraska",
    NV: "Nevada",
    NH: "New Hampshire",
    NJ: "New Jersey",
    NM: "New Mexico",
    NY: "New York",
    NC: "North Carolina",
    ND: "North Dakota",
    OH: "Ohio",
    OK: "Oklahoma",
    OR: "Oregon",
    PA: "Pennsylvania",
    RI: "Rhode Island",
    SC: "South Carolina",
    SD: "South Dakota",
    TN: "Tennessee",
    TX: "Texas",
    UT: "Utah",
    VT: "Vermont",
    VA: "Virginia",
    WA: "Washington",
    WV: "West Virginia",
    WI: "Wisconsin",
    WY: "Wyoming"
  };

  /** Fields whose answers should be chosen from a dropdown/list, not typed as free text. */
  const SELECT_LIKE_KEYS = new Set([
    "workAuthorized",
    "needsSponsorship",
    "postEmploymentRestrictions",
    "willingToRelocate",
    "over18",
    "felonyConviction",
    "backgroundCheckConsent",
    "drugTestConsent",
    "gender",
    "hispanicLatino",
    "raceEthnicity",
    "veteranStatus",
    "disabilityStatus",
    "englishLevel",
    "highestDegree",
    "state",
    "phoneDeviceType",
    "phoneCountryCode",
    "workedForCompanyBefore",
    "relatedToEmployee",
    "governmentEmployee",
    "governmentEthicsRecusal"
  ]);

  const VALUE_LABELS = {
    workAuthorized: { yes: ["Yes"], no: ["No"] },
    needsSponsorship: { yes: ["Yes"], no: ["No"] },
    willingToRelocate: { yes: ["Yes"], no: ["No"] },
    over18: { yes: ["Yes"], no: ["No"] },
    felonyConviction: { yes: ["Yes"], no: ["No"] },
    backgroundCheckConsent: { yes: ["Yes"], no: ["No"] },
    drugTestConsent: { yes: ["Yes"], no: ["No"] },
    postEmploymentRestrictions: { yes: ["Yes"], no: ["No"] },
    workedForCompanyBefore: { yes: ["Yes"], no: ["No"] },
    relatedToEmployee: { yes: ["Yes"], no: ["No"] },
    governmentEmployee: { yes: ["Yes"], no: ["No"] },
    governmentEthicsRecusal: { yes: ["Yes"], no: ["No"] },
    hispanicLatino: { yes: ["Yes"], no: ["No"] },
    gender: {
      female: ["Female", "Woman", "F"],
      male: ["Male", "Man", "M"],
      non_binary: ["Non-binary", "Nonbinary", "Non binary"],
      other: ["Other", "Self-describe", "Self describe"]
    },
    raceEthnicity: {
      american_indian: ["American Indian or Alaska Native", "American Indian", "Alaska Native"],
      asian: ["Asian"],
      black: ["Black or African American", "Black", "African American"],
      hispanic: [
        "Hispanic or Latino",
        "Hispanic, Latinx or of Spanish Origin",
        "Hispanic",
        "Latino",
        "Latinx",
        "Spanish Origin"
      ],
      native_hawaiian: [
        "Native Hawaiian or Other Pacific Islander",
        "Native Hawaiian",
        "Pacific Islander"
      ],
      white: ["White", "Caucasian"],
      two_or_more: ["Two or more races", "Two or more", "Multiracial"]
    },
    veteranStatus: {
      not_veteran: [
        "I am not a protected veteran",
        "No, I am not a veteran or active member",
        "I am not a veteran",
        "Not a veteran",
        "No"
      ],
      protected_veteran: [
        "I identify as a protected veteran",
        "Yes, I am a veteran",
        "Protected veteran",
        "Yes"
      ],
      decline: ["I decline to self-identify", "Prefer not to say", "I do not wish to answer"]
    },
    disabilityStatus: {
      yes: [
        "Yes, I have a disability, or have had one in the past",
        "Yes, I have a disability",
        "Yes"
      ],
      no: [
        "No, I do not have a disability and have not had one in the past",
        "No, I do not have a disability",
        "No"
      ],
      decline: ["I do not want to answer", "I do not wish to answer", "Prefer not to say"]
    },
    englishLevel: {
      A1: ["A1"],
      A2: ["A2"],
      B1: ["B1"],
      B2: ["B2"],
      C1: ["C1", "C1 Advanced", "Advanced"],
      C2: ["C2", "C2 Proficiency", "Proficient"],
      native: ["Native", "Native / bilingual", "Bilingual", "Fluent"]
    },
    highestDegree: {
      high_school: ["High School", "High School Diploma", "GED"],
      associate: ["Associate", "Associate's", "Associates"],
      bachelor: ["Bachelor", "Bachelor's", "Bachelors", "BS", "BA"],
      master: ["Master", "Master's", "Masters", "MS", "MA", "MBA"],
      doctorate: ["Doctorate", "PhD", "Ph.D.", "Doctoral"],
      other: ["Other"]
    },
    phoneDeviceType: {
      mobile: ["Mobile", "Cell", "Cell Phone", "Mobile Phone", "Smartphone"],
      home: ["Home", "Home Phone", "Landline"],
      work: ["Work", "Work Phone", "Business"]
    }
  };

  const YES_VALUES = new Set(["yes", "y", "true", "1"]);
  const NO_VALUES = new Set(["no", "n", "false", "0"]);

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function expandValueCandidates(key, value) {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const out = [raw];
    const map = VALUE_LABELS[key];
    if (map && map[raw]) {
      for (const label of map[raw]) {
        if (label && !out.includes(label)) out.push(label);
      }
    }
    if (key === "state") {
      const code = raw.toUpperCase();
      const full = US_STATE_LABELS[code];
      if (full && !out.includes(full)) out.push(full);
      const byName = Object.entries(US_STATE_LABELS).find(
        ([, label]) => normalize(label) === normalize(raw)
      );
      if (byName && !out.includes(byName[0])) out.push(byName[0]);
    }
    if (key === "phoneCountryCode") {
      if (/united states|usa|\bus\b/i.test(raw)) {
        for (const label of [
          "United States of America (+1)",
          "United States (+1)",
          "US (+1)",
          "+1",
          "United States"
        ]) {
          if (!out.includes(label)) out.push(label);
        }
      }
    }
    if (/^(yes|no)$/i.test(raw)) {
      const titled = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      if (!out.includes(titled)) out.push(titled);
    }
    return out;
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    try {
      if (descriptor?.set) descriptor.set.call(el, value);
      else el.value = value;
    } catch {
      return false;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  const DATE_LIKE_TYPES = new Set(["date", "month", "week", "time", "datetime-local"]);

  function toDateParts(raw) {
    const s = String(raw || "").trim();

    let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (m) {
      return { year: m[1], month: m[2].padStart(2, "0"), day: (m[3] || "01").padStart(2, "0") };
    }

    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) {
      return { year: m[3], month: m[1].padStart(2, "0"), day: m[2].padStart(2, "0") };
    }

    // Only attempt free-form parsing when a 4-digit year is present, so values
    // like "5" are not silently reinterpreted as a date by the Date constructor.
    if (/\b\d{4}\b/.test(s)) {
      const parsed = Date.parse(s);
      if (!Number.isNaN(parsed)) {
        const d = new Date(parsed);
        return {
          year: String(d.getFullYear()),
          month: String(d.getMonth() + 1).padStart(2, "0"),
          day: String(d.getDate()).padStart(2, "0")
        };
      }
    }

    return null;
  }

  function withinInputRange(el, type, value) {
    const min = el.getAttribute("min");
    const max = el.getAttribute("max");
    if (!min && !max) return true;

    if (type === "number" || type === "range") {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      if (min && Number.isFinite(Number(min)) && n < Number(min)) return false;
      if (max && Number.isFinite(Number(max)) && n > Number(max)) return false;
      return true;
    }

    // ISO date/time strings compare correctly as plain strings.
    if (min && value < min) return false;
    if (max && value > max) return false;
    return true;
  }

  /**
   * Reshape a profile answer into something the input type can actually store.
   * Returns null when the value cannot be represented, so the caller skips the
   * field instead of asking the browser to parse an invalid value.
   */
  function coerceValueForInput(el, rawValue) {
    const type = (el.type || "text").toLowerCase();
    const raw = String(rawValue ?? "").trim();
    if (!raw) return null;

    let out = raw;

    if (DATE_LIKE_TYPES.has(type)) {
      if (type === "time") {
        const m = raw.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
        out = m ? `${m[1].padStart(2, "0")}:${m[2]}${m[3] || ""}` : null;
      } else if (type === "week") {
        out = /^\d{4}-W\d{2}$/i.test(raw) ? raw.toUpperCase() : null;
      } else {
        const parts = toDateParts(raw);
        if (!parts) {
          out = null;
        } else if (type === "month") {
          out = `${parts.year}-${parts.month}`;
        } else if (type === "date") {
          out = `${parts.year}-${parts.month}-${parts.day}`;
        } else {
          out = `${parts.year}-${parts.month}-${parts.day}T09:00`;
        }
      }
    } else if (type === "number" || type === "range") {
      const m = raw.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      out = m ? m[0] : null;
    } else if (type === "color") {
      out = /^#[0-9a-f]{6}$/i.test(raw) ? raw : null;
    } else if (type === "email") {
      out = /\S+@\S+\.\S+/.test(raw) ? raw : null;
    } else if (type === "url") {
      if (/^https?:\/\/\S+$/i.test(raw)) out = raw;
      else if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw)) out = `https://${raw}`;
      else out = null;
    }

    if (out == null) return null;
    if (!withinInputRange(el, type, out)) return null;
    return out;
  }

  function cleanLabelText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtmlText(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function labelTextForControl(el) {
    const parts = [];
    if (el.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor) parts.push(byFor.textContent || "");
      } catch {
        /* ignore invalid id */
      }
    }
    const wrapping = el.closest("label");
    if (wrapping) parts.push(wrapping.textContent || "");
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (node) parts.push(node.textContent || "");
      }
    }
    parts.push(el.getAttribute("aria-label") || "");
    parts.push(el.getAttribute("placeholder") || "");
    parts.push(el.getAttribute("name") || "");
    parts.push(el.getAttribute("autocomplete") || "");
    const prev = el.previousElementSibling;
    if (prev && /LABEL|SPAN|DIV|P|LEGEND/i.test(prev.tagName)) {
      parts.push(prev.textContent || "");
    }
    // Walk up a few parents for ATS question wrappers (Ashby / Greenhouse).
    let parent = el.parentElement;
    for (let i = 0; i < 4 && parent; i += 1) {
      const heading = parent.querySelector(
        ":scope > label, :scope > legend, :scope > p, :scope > span, :scope > div > label"
      );
      if (heading && heading !== el) parts.push(heading.textContent || "");
      const q = parent.getAttribute?.("data-question") || parent.getAttribute?.("aria-label");
      if (q) parts.push(q);
      parent = parent.parentElement;
    }
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) parts.push(legend.textContent || "");
    }
    return normalize(parts.join(" "));
  }

  function aliasMatchesLabel(aliasNorm, labelNorm) {
    if (!aliasNorm || !labelNorm) return false;
    // Phrase aliases may be followed by more words ("eligible to work in the US").
    if (labelNorm.includes(aliasNorm)) return true;
    const escaped = aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(labelNorm);
  }

  /**
   * Extract the question/field label above a control (Workday legend/label, fieldset,
   * formField containers, aria-labelledby, etc.).
   * Prefer the closest short field label — never the longest ancestor blob, which
   * used to steal a nearby Yes/No question and fill "Yes" into First name.
   */
  function questionLabelForControl(el) {
    const ranked = [];

    function add(text, score) {
      const t = cleanLabelText(text);
      if (!t || t.length < 2) return;
      if (/^(select one|please select|choose|--|\* indicates a required field)$/i.test(t)) return;
      let s = score;
      if (t.length > 160) s -= 500;
      else if (t.length > 80) s -= 140;
      else if (t.length <= 40) s += 50;
      ranked.push({ t, s });
    }

    if (el.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor) add(byFor.textContent, 1200);
      } catch {
        /* ignore */
      }
    }

    const wrapping = el.closest("label");
    if (wrapping) {
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, button").forEach((n) => n.remove());
      add(clone.textContent, 1100);
    }

    add(el.getAttribute("aria-label") || "", 1050);
    add(el.getAttribute("placeholder") || "", 500);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const labelNode = document.getElementById(id);
        if (labelNode) add(labelNode.textContent, 1000);
      }
    }

    const prev = el.previousElementSibling;
    if (prev && /^(LABEL|LEGEND|P|SPAN|DIV|H\d)$/i.test(prev.tagName)) {
      add(prev.textContent, 900);
    }

    const type = (el.type || "").toLowerCase();
    const isChoice = type === "radio" || type === "checkbox";
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend");
      if (legend) add(legend.textContent, isChoice ? 850 : 350);
    }

    let container = el.parentElement;
    for (let depth = 0; depth < 4 && container; depth += 1) {
      const autoId = String(container.getAttribute?.("data-automation-id") || "");
      const isFormBlock =
        /formfield|form-field|formField|question|applicationquestion|multiselect/i.test(autoId) ||
        container.tagName === "FIELDSET";
      if (isFormBlock) {
        for (const labelEl of container.querySelectorAll(
          ':scope > label, :scope > legend, [data-automation-id="formLabel"], [data-automation-id*="formLabel"], label[data-automation-id]'
        )) {
          if (labelEl.contains(el)) continue;
          add(labelEl.textContent, 800 - depth * 80);
        }
      }
      for (const labelEl of container.querySelectorAll(":scope > label, :scope > legend")) {
        if (labelEl.contains(el)) continue;
        add(labelEl.textContent, 720 - depth * 80);
      }
      container = container.parentElement;
    }

    ranked.sort((a, b) => b.s - a.s);
    return ranked[0]?.t || "";
  }

  /** Direct field label — uses Workday-aware question label extraction. */
  function primaryLabelForControl(el) {
    return normalize(questionLabelForControl(el));
  }

  function matchApplicantKey(labelNorm, primaryLabelNorm = "") {
    const primary = primaryLabelNorm || labelNorm;
    if (!primary && !labelNorm) return null;

    let best = null;
    let bestScore = 0;

    for (const key of FIELD_MATCH_ORDER) {
      const aliases = FIELD_ALIASES[key];
      if (!aliases) continue;
      for (const alias of aliases) {
        const a = normalize(alias);
        if (!a) continue;
        const onPrimary = primary && aliasMatchesLabel(a, primary);
        const onFull = labelNorm && aliasMatchesLabel(a, labelNorm);
        if (!onPrimary && !onFull) continue;

        // Prefer matches on the direct field label over section headers.
        let score = a.length + (onPrimary ? 1000 : 0);

        // City/state/zip must win over generic address section text.
        if (["city", "state", "zipCode", "addressLine2"].includes(key)) score += 200;
        if (key === "addressLine1" && /\b(line 1|street|address 1|home address)\b/.test(primary)) {
          score += 150;
        }
        if (key === "phone" && /\b(extension|device type|country phone code|phone code)\b/.test(primary)) {
          continue;
        }
        if (key === "workAuthorized" && /\bsponsorship\b/.test(primary)) continue;
        if (key === "needsSponsorship" && /\beligible to work\b/.test(primary) && !/\bsponsorship\b/.test(primary)) {
          continue;
        }
        if (key === "workedForCompanyBefore" && !/\b(worked|employed|subsidiary|past|before)\b/.test(primary)) {
          continue;
        }
        if (key === "relatedToEmployee" && !/\b(related|relationship)\b/.test(primary)) continue;
        if (key === "governmentEmployee" && !/\bgovernment\b/.test(primary)) continue;
        if (key === "governmentEthicsRecusal" && !/\b(ethics|recused)\b/.test(primary)) continue;

        if (score > bestScore) {
          best = key;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function matchApplicantKeyFromControl(el) {
    const autocomplete = normalize(el.getAttribute("autocomplete") || "");
    if (autocomplete === "tel-extension") return null;
    if (AUTOCOMPLETE_FIELD_MAP[autocomplete]) return AUTOCOMPLETE_FIELD_MAP[autocomplete];

    const question = questionLabelForControl(el);
    const primary = normalize(question);
    const full = primary || labelTextForControl(el);

    if (/\bextension\b/.test(primary)) return null;
    if (/\bdevice type\b/.test(primary)) return "phoneDeviceType";
    if (/\b(country phone code|phone country code|phone code)\b/.test(primary)) {
      return "phoneCountryCode";
    }

    const shortPrimary = primary && primary.length <= 180;
    if (shortPrimary && /\b(require|need)\b/.test(primary) && /\bsponsorship\b/.test(primary)) {
      return "needsSponsorship";
    }
    if (shortPrimary && /\b(eligible|legally authorized|authorized)\b/.test(primary) && /\bwork\b/.test(primary)) {
      return "workAuthorized";
    }
    if (shortPrimary && (/\bcontinuing employment restrictions\b/.test(primary) || /\bemployment restrictions or obligations\b/.test(primary))) {
      return "postEmploymentRestrictions";
    }
    if (shortPrimary && /\bhave you worked for\b/.test(primary) && /\b(past|before|previously|subsidiary)\b/.test(primary)) {
      return "workedForCompanyBefore";
    }
    if (shortPrimary && (/\bclosely related\b/.test(primary) || /\bpersonal relationship\b/.test(primary))) {
      return "relatedToEmployee";
    }
    if (shortPrimary && /\bgovernment employee\b/.test(primary)) return "governmentEmployee";
    if (shortPrimary && (/\bethics official\b/.test(primary) || /\brecused yourself\b/.test(primary))) {
      return "governmentEthicsRecusal";
    }

    return matchApplicantKey(full, primary);
  }

  /**
   * Clearest question text for OpenAI — prefers real labels / previous sibling,
   * skips placeholder noise like "Type here...".
   */
  function questionTextForAi(el) {
    const candidates = [];
    if (el.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor) candidates.push(cleanLabelText(byFor.textContent));
      } catch {
        /* ignore */
      }
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, button").forEach((n) => n.remove());
      candidates.push(cleanLabelText(clone.textContent));
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (node) candidates.push(cleanLabelText(node.textContent));
      }
    }
    const aria = cleanLabelText(el.getAttribute("aria-label"));
    if (aria) candidates.push(aria);

    const prev = el.previousElementSibling;
    if (prev && /LABEL|SPAN|DIV|P|LEGEND|H1|H2|H3|H4|H5|H6/i.test(prev.tagName)) {
      candidates.push(cleanLabelText(prev.textContent));
    }

    let best = "";
    for (const c of candidates) {
      if (!c) continue;
      if (/^(type here|enter text|write here|your answer)\.?$/i.test(c)) continue;
      if (c.length > best.length) best = c;
    }
    if (best) return best.slice(0, 1000);

    return cleanLabelText(labelTextForControl(el)).slice(0, 1000);
  }

  function isYesNoValue(value) {
    const v = normalize(value);
    return YES_VALUES.has(v) || NO_VALUES.has(v);
  }

  /**
   * Match a dropdown option against a desired answer.
   * For yes/no, prefer options that start with Yes/No — never use naive substring
   * matching (avoids "no" matching "Non-binary" / "non-hispanic").
   */
  function optionMatches(optionText, desired) {
    const opt = normalize(optionText);
    const want = normalize(desired);
    if (!opt || !want) return false;
    if (opt === want) return true;

    if (isYesNoValue(want)) {
      const yes = YES_VALUES.has(want);
      if (yes) {
        return opt === "yes" || opt === "y" || opt.startsWith("yes ") || opt.startsWith("yes,");
      }
      return opt === "no" || opt === "n" || opt.startsWith("no ") || opt.startsWith("no,");
    }

    if (opt.includes(want) || want.includes(opt)) return true;

    // Token overlap for longer labels (e.g. disability / veteran phrasing).
    const wantTokens = want.split(" ").filter((t) => t.length > 2);
    if (wantTokens.length >= 3) {
      const hit = wantTokens.filter((t) => opt.includes(t)).length;
      if (hit / wantTokens.length >= 0.6) return true;
    }
    return false;
  }

  function optionMatchesAny(optionText, candidates) {
    return candidates.some((c) => optionMatches(optionText, c));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fillSelect(select, value, key = null) {
    if (value == null || value === "") return false;
    const candidates = key ? expandValueCandidates(key, value) : [String(value)];
    const match = [...select.options].find((o) =>
      optionMatchesAny(o.textContent || o.value, candidates)
    );
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** Greenhouse / Ashby / generic React-Select control detection. */
  function getReactSelectRoot(el) {
    if (!el) return null;
    return (
      el.closest(".select__control") ||
      el.closest("[class*='select__control']") ||
      el.closest(".select__container") ||
      el.closest("[class*='react-select']") ||
      null
    );
  }

  function isReactSelectInput(el) {
    if (!el) return false;
    if (el.classList?.contains("select__input")) return true;
    if (/^react-select-\d+-input$/i.test(el.id || "")) return true;
    if (el.closest?.(".select__input-container, [class*='select__input']")) return true;
    return Boolean(getReactSelectRoot(el));
  }

  function looksLikeCombobox(el) {
    if (!el) return false;
    if (isRichTextEditor(el)) return false;
    if (isReactSelectInput(el)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "combobox" || role === "listbox") return true;
    if (el.getAttribute("aria-haspopup") === "listbox") return true;
    if (el.getAttribute("aria-haspopup") === "true" && el.getAttribute("aria-autocomplete")) {
      return true;
    }
    if (el.getAttribute("aria-autocomplete") === "list") return true;
    if (el.getAttribute("aria-expanded") != null && role === "combobox") return true;
    return Boolean(
      el.closest?.(
        '[role="combobox"], .select__control, [class*="select__control"], [class*="dropdown"]'
      )
    );
  }

  function collectVisibleOptions(root = document) {
    const selectors = [
      ".select__option",
      "[class*='select__option']",
      '[id*="react-select-"][id*="-option-"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="treeitem"]',
      "li[data-value]",
      ".select-option"
    ];
    const nodes = [];
    for (const sel of selectors) {
      try {
        nodes.push(...root.querySelectorAll(sel));
      } catch {
        /* ignore */
      }
    }
    const seen = new Set();
    const out = [];
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      // Skip disabled / placeholder options.
      if (node.getAttribute("aria-disabled") === "true") continue;
      if (node.classList?.contains("select__option--is-disabled")) continue;
      const text = cleanLabelText(node.textContent);
      if (!text || text.length > 300) continue;
      if (/^select\.\.\.?$/i.test(text)) continue;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      out.push(node);
    }
    return out;
  }

  function clickOptionNode(node) {
    if (!node) return false;
    const clickable =
      node.closest("[role='option'], .select__option, [class*='select__option'], li, button") ||
      node;
    // React-Select listens to mousedown more reliably than click alone.
    clickable.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window })
    );
    clickable.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
    );
    clickable.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
    );
    clickable.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
    );
    return true;
  }

  function openReactSelect(el) {
    const control =
      getReactSelectRoot(el) ||
      el.closest?.("[class*='select__control']") ||
      el.closest?.('[role="combobox"]') ||
      el;
    const indicator =
      control.querySelector?.(
        ".select__dropdown-indicator, [class*='select__dropdown-indicator'], button[aria-label*='flyout'], button[aria-label*='Toggle']"
      ) || null;

    const target = indicator || control;
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
    );
    target.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
    );
    target.click?.();

    // Focus the real search input so filtering / keyboard works.
    const input =
      (el.tagName === "INPUT" ? el : null) ||
      control.querySelector?.("input.select__input, input[role='combobox'], input") ||
      el;
    try {
      input.focus?.();
    } catch {
      /* ignore */
    }
    return input;
  }

  function setReactSelectFilter(input, text) {
    if (!input || input.tagName !== "INPUT") return;
    setNativeValue(input, text);
    // React-Select also watches InputEvent / keyup.
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: text.slice(-1) || "a" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: text.slice(-1) || "a" }));
  }

  function clearReactSelectFilter(input) {
    if (!input || input.tagName !== "INPUT") return;
    setNativeValue(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
  }

  async function waitForOptions(attempts = 8, delayMs = 80) {
    for (let i = 0; i < attempts; i += 1) {
      const options = collectVisibleOptions(document);
      if (options.length) return options;
      await sleep(delayMs);
    }
    return [];
  }

  async function fillCustomDropdown(el, value, key = null) {
    if (value == null || String(value).trim() === "") return false;
    const candidates = key ? expandValueCandidates(key, value) : [String(value).trim()];
    const reactSelect = isReactSelectInput(el);

    // Prefer already-open menu options.
    let options = collectVisibleOptions(document);
    let match = options.find((n) => optionMatchesAny(n.textContent, candidates));
    if (match) return clickOptionNode(match);

    const input = openReactSelect(el);
    options = await waitForOptions(reactSelect ? 10 : 6, reactSelect ? 100 : 80);
    match = options.find((n) => optionMatchesAny(n.textContent, candidates));
    if (match) {
      const ok = clickOptionNode(match);
      if (reactSelect) clearReactSelectFilter(input);
      return ok;
    }

    // Filter the menu (Greenhouse React-Select), then pick — never leave typed text as the answer.
    const filterText =
      candidates.find((c) => String(c).trim().length >= 1 && !isYesNoValue(c)) ||
      candidates.find((c) => /^(Yes|No)$/i.test(String(c).trim())) ||
      candidates[0];

    if (input && input.tagName === "INPUT") {
      setReactSelectFilter(input, filterText);
      options = await waitForOptions(reactSelect ? 10 : 6, 100);
      match = options.find((n) => optionMatchesAny(n.textContent, candidates));
      if (match) {
        const ok = clickOptionNode(match);
        clearReactSelectFilter(input);
        return ok;
      }

      // Keyboard fallback: highlight first filtered option and confirm.
      input.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", code: "ArrowDown" })
      );
      await sleep(60);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" })
      );
      await sleep(80);

      // Did a value chip / single-value appear?
      const root = getReactSelectRoot(el) || el.closest?.(".select__control")?.parentElement;
      const selected = root?.querySelector?.(
        ".select__single-value, .select__multi-value__label, [class*='select__single-value']"
      );
      if (selected && optionMatchesAny(selected.textContent, candidates)) {
        clearReactSelectFilter(input);
        return true;
      }

      // Never leave free-text in a React-Select / combobox.
      clearReactSelectFilter(input);
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
    }

    return false;
  }

  function fillCheckboxOrRadio(el, value, key = null) {
    if (value == null || value === "") return false;
    const candidates = key ? expandValueCandidates(key, value) : [String(value)];
    const wantYes = YES_VALUES.has(normalize(value));
    const label = labelTextForControl(el);
    const optionSide = normalize(el.value || "") || label;

    if (el.type === "checkbox") {
      const shouldCheck = isYesNoValue(value)
        ? wantYes
        : optionMatchesAny(optionSide, candidates) || optionMatchesAny(label, candidates);
      if (el.checked !== shouldCheck) el.click();
      return true;
    }

    if (el.type === "radio") {
      const matchesOption =
        optionMatchesAny(el.value, candidates) || optionMatchesAny(optionSide, candidates);
      const yesNoOnGroup =
        isYesNoValue(value) &&
        ((wantYes && (optionSide.startsWith("yes") || optionSide === "y")) ||
          (!wantYes &&
            (optionSide === "no" ||
              optionSide.startsWith("no ") ||
              optionSide.startsWith("no,") ||
              optionSide === "n")));
      if (matchesOption || yesNoOnGroup) {
        if (!el.checked) el.click();
        return true;
      }
    }
    return false;
  }

  async function fillControl(el, value, key = null) {
    if (value == null || String(value).trim() === "") return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName.toLowerCase();
    const label = questionLabelForControl(el) || labelTextForControl(el);
    const identityLabel =
      /\b(first name|last name|given name|surname|family name|middle name|preferred name|email|e-mail|phone|mobile|linkedin|address|city|state|zip|postal|country)\b/i.test(
        label
      );
    const identityKey = [
      "firstName",
      "lastName",
      "middleName",
      "preferredName",
      "email",
      "phone",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "zipCode",
      "country",
      "linkedinUrl"
    ].includes(key);
    if (
      isYesNoValue(value) &&
      (identityKey || identityLabel) &&
      tag !== "select" &&
      el.type !== "checkbox" &&
      el.type !== "radio"
    ) {
      return false;
    }

    if (tag === "select") return fillSelect(el, value, key);

    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return fillCheckboxOrRadio(el, value, key);
      if (["hidden", "file", "submit", "button", "image", "reset"].includes(type)) return false;

      // React-Select / combobox: ONLY pick from the option list — never type an answer.
      if (isReactSelectInput(el) || looksLikeCombobox(el)) {
        return fillCustomDropdown(el, value, key);
      }

      // Known select-like profile fields: try list first; never leave lowercase yes/no typed in.
      if (SELECT_LIKE_KEYS.has(key) || isYesNoValue(value)) {
        const ok = await fillCustomDropdown(el, value, key);
        if (ok) return true;
        if (isYesNoValue(value) || SELECT_LIKE_KEYS.has(key)) return false;
      }

      const coerced = coerceValueForInput(el, value);
      if (coerced == null) return false;
      if (!setNativeValue(el, coerced)) return false;
      // Inputs such as date / number silently drop values they cannot represent.
      return Boolean(String(el.value || "").trim());
    }

    if (tag === "textarea") {
      if (SELECT_LIKE_KEYS.has(key) || isYesNoValue(value) || looksLikeCombobox(el)) {
        const ok = await fillCustomDropdown(el, value, key);
        if (ok) return true;
        if (isYesNoValue(value) || SELECT_LIKE_KEYS.has(key) || looksLikeCombobox(el)) return false;
      }
      setNativeValue(el, String(value));
      return true;
    }

    if (isRichTextEditor(el)) return fillContentEditable(el, value);

    // Non-input combobox buttons / divs / react-select controls
    if (looksLikeCombobox(el) || isReactSelectInput(el) || el.getAttribute("role") === "combobox") {
      return fillCustomDropdown(el, value, key);
    }

    return false;
  }

  function base64ToFile(base64, fileName, mimeType) {
    const binary = atob(String(base64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], fileName || "upload.pdf", {
      type: mimeType || "application/pdf",
      lastModified: Date.now()
    });
  }

  function classifyFileInput(el) {
    const label = fileFieldContext(el);
    const name = normalize(
      [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("accept"), label].join(" ")
    );
    if (
      /cover\s*letter|covering\s*letter|coverletter/.test(name) &&
      !/\b(attach any|any files|additional files)\b/.test(name) &&
      !/\bcover letter is not required\b/.test(name)
    ) {
      return "coverLetter";
    }
    if (
      /\b(any files|additional files|other files|supporting documents|optional attachment|attach any)\b/.test(
        name
      )
    ) {
      return "other";
    }
    if (/\b(resume|cv|curriculum|vitae|include your resume)\b/.test(name)) return "resume";
    if (/\brequired\b/.test(name) && /\b(attach|upload|file|pdf)\b/.test(name) && !/\bcover\b/.test(name)) {
      return "resume";
    }
    return "other";
  }

  function fileFieldRoot(el) {
    let node = el?.parentElement || null;
    let last = node;
    while (node) {
      const files = node.querySelectorAll?.('input[type="file"]') || [];
      if (files.length > 1) return last;
      last = node;
      const blob = `${node.className || ""} ${node.getAttribute?.("data-testid") || ""} ${
        node.getAttribute?.("data-automation-id") || ""
      }`;
      if (/\b(dropzone|drop-zone|file-upload|fileupload|attachment)\b/i.test(blob)) return node;
      node = node.parentElement;
    }
    return last;
  }

  function fileFieldContext(el) {
    const parts = [labelTextForControl(el)];
    let node = el?.parentElement || null;
    while (node) {
      const files = node.querySelectorAll?.('input[type="file"]') || [];
      if (files.length > 1) break;
      const clone = node.cloneNode(true);
      clone
        .querySelectorAll("input, textarea, select, button, svg, [contenteditable]")
        .forEach((n) => n.remove());
      const t = cleanLabelText(clone.textContent).slice(0, 400);
      if (t) parts.push(t);
      const blob = parts.join(" ");
      if (/\b(resume|cv|curriculum|vitae|cover letter|attach any|additional files)\b/i.test(blob)) {
        break;
      }
      node = node.parentElement;
    }
    return parts.filter(Boolean).join(" ");
  }

  function scoreResumeField(label) {
    const n = normalize(label);
    let score = 0;
    if (/\binclude your resume\b/.test(n)) score += 120;
    if (/\b(resume|cv|curriculum|vitae)\b/.test(n)) score += 60;
    if (/\brequired\b/.test(n)) score += 25;
    if (/\b(optional|any files|additional|attach any|not required)\b/.test(n)) score -= 100;
    return score;
  }

  function dropzoneForInput(input) {
    const root = fileFieldRoot(input);
    if (!root) return input;
    return (
      root.querySelector(
        '[class*="drop"], [class*="Drop"], [data-testid*="drop"], [data-testid*="upload"], [class*="upload"]'
      ) || root
    );
  }

  function dispatchFileDrop(target, file) {
    if (!target || !file) return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const fire = (type) => {
        let event;
        try {
          event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        } catch {
          event = new Event(type, { bubbles: true, cancelable: true });
        }
        try {
          Object.defineProperty(event, "dataTransfer", { value: dt });
        } catch {
          /* some browsers freeze dataTransfer */
        }
        target.dispatchEvent(event);
      };
      fire("dragenter");
      fire("dragover");
      fire("drop");
      return true;
    } catch {
      return false;
    }
  }

  function setFileOnInput(input, file) {
    if (!input || !file) return false;
    let ok = false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(
        new CustomEvent("file-upload-success", { bubbles: true, detail: { fileName: file.name } })
      );
      ok = Boolean(input.files && input.files.length > 0);
    } catch {
      ok = false;
    }
    dispatchFileDrop(dropzoneForInput(input), file);
    return ok || Boolean(input.files && input.files.length > 0);
  }

  function collectFileInputs() {
    return [...document.querySelectorAll('input[type="file"]')].filter((el) => {
      if (el.disabled) return false;
      return true;
    });
  }

  async function revealApplicationUploads() {
    const re =
      /upload (a )?(new )?(resume|cv|cover letter)|attach (a )?(resume|cv|cover letter)|add (a )?cover letter|replace (resume|cv)/i;
    const controls = [...document.querySelectorAll("button, a, [role='button'], label")].filter(
      (el) => isElVisible(el) && isElEnabled(el)
    );
    let clicked = 0;
    for (const el of controls) {
      const text = elActionText(el);
      if (!re.test(text)) continue;
      try {
        scrollElIntoView(el);
        el.click();
        clicked += 1;
        await sleep(450);
      } catch {
        /* ignore */
      }
      if (clicked >= 3) break;
    }
    return clicked;
  }

  function uploadsStillBusy() {
    const scope = getApplyScope() || document;
    const blob = cleanLabelText(scope.innerText || "").slice(0, 8000).toLowerCase();
    if (/\b(uploading|upload in progress|processing (your )?(file|document|resume|cover)|please wait while .{0,40}upload)\b/i.test(blob)) {
      return true;
    }
    const busySel = [
      '[class*="upload"][class*="progress"]',
      '[class*="Upload"][class*="Progress"]',
      '[class*="file-upload"] [role="progressbar"]',
      '[data-testid*="upload"] [role="progressbar"]',
      '[aria-busy="true"]',
      ".MuiCircularProgress-root",
      '[class*="spinner"]',
      '[class*="Spinner"]',
      '[class*="loading-bar"]'
    ].join(", ");
    for (const el of scope.querySelectorAll?.(busySel) || []) {
      if (!isElVisible(el)) continue;
      // Ignore global page spinners far from file widgets.
      if (el.closest?.('input[type="file"], [class*="drop"], [class*="upload"], [class*="Upload"], [class*="attachment"]')) {
        return true;
      }
      if (/\b(upload|file|resume|cover|document)\b/i.test(fileFieldContext(el) || el.getAttribute?.("aria-label") || "")) {
        return true;
      }
    }
    // File inputs that still look empty after we intended to attach something.
    for (const input of collectFileInputs()) {
      const kind = classifyFileInput(input);
      if (kind !== "resume" && kind !== "coverLetter") continue;
      if (!(input.files && input.files.length)) {
        // Some SPAs clear the input after ingesting; only treat as busy if UI still asks to upload.
        const ctx = fileFieldContext(input).toLowerCase();
        if (/\b(required|upload|attach|drag)\b/.test(ctx) && !/\b(uploaded|attached|selected|replace)\b/.test(ctx)) {
          return true;
        }
      }
    }
    return false;
  }

  async function waitForUploadsToSettle(timeoutMs = 20000) {
    const start = Date.now();
    // Give the SPA a moment to start its upload handler after change/drop.
    await sleep(600);
    while (Date.now() - start < timeoutMs) {
      if (!uploadsStillBusy()) {
        // Require two quiet samples so brief spinners don't false-clear.
        await sleep(450);
        if (!uploadsStillBusy()) return true;
      }
      await sleep(400);
    }
    return !uploadsStillBusy();
  }

  async function uploadApplicationFiles(uploadFiles = {}) {
    await revealApplicationUploads();
    const uploaded = [];
    const skipped = [];
    const resumeDoc = uploadFiles.resume;
    const coverDoc = uploadFiles.coverLetter;

    const resumeFile =
      resumeDoc?.base64 &&
      base64ToFile(resumeDoc.base64, resumeDoc.fileName || "Resume.pdf", resumeDoc.mimeType);
    const coverFile =
      coverDoc?.base64 &&
      base64ToFile(
        coverDoc.base64,
        coverDoc.fileName || "Cover_Letter.pdf",
        coverDoc.mimeType
      );

    if (!resumeFile && !coverFile) {
      return { uploadedCount: 0, uploaded, skipped: [{ reason: "no-docs" }], settled: true };
    }

    const inputs = collectFileInputs();
    if (!inputs.length) {
      return { uploadedCount: 0, uploaded, skipped: [{ reason: "no-file-inputs" }], settled: true };
    }

    const classified = inputs.map((input) => ({
      input,
      kind: classifyFileInput(input),
      label: fileFieldContext(input)
    }));

    const resumeRows = classified
      .filter((row) => row.kind === "resume")
      .sort((a, b) => scoreResumeField(b.label) - scoreResumeField(a.label));
    const coverRows = classified.filter((row) => row.kind === "coverLetter");
    const targets = [];
    if (resumeFile && resumeRows.length) targets.push({ ...resumeRows[0], file: resumeFile, kind: "resume" });
    if (coverFile) {
      for (const row of coverRows) targets.push({ ...row, file: coverFile, kind: "coverLetter" });
    }
    const targetedInputs = new Set(targets.map((row) => row.input));
    if (resumeFile && !targets.some((row) => row.kind === "resume")) {
      const fallback = classified.find((row) => !targetedInputs.has(row.input));
      if (fallback) {
        targets.push({ ...fallback, file: resumeFile, kind: "resume" });
        targetedInputs.add(fallback.input);
      }
    }
    if (coverFile && !targets.some((row) => row.kind === "coverLetter")) {
      const leftover = classified.find((row) => !targetedInputs.has(row.input));
      if (leftover) targets.push({ ...leftover, file: coverFile, kind: "coverLetter" });
    }

    // Top → bottom: resume first, then cover letter.
    targets.sort((a, b) => {
      const order = { resume: 0, coverLetter: 1 };
      const byKind = (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
      if (byKind) return byKind;
      const ay = a.input.getBoundingClientRect?.().top || 0;
      const by = b.input.getBoundingClientRect?.().top || 0;
      return ay - by;
    });

    const used = new WeakSet();
    for (const row of targets) {
      if (!row.file || used.has(row.input)) continue;
      scrollElIntoView(row.input);
      await sleep(200);
      const ok = setFileOnInput(row.input, row.file);
      if (ok) {
        used.add(row.input);
        uploaded.push({
          kind: row.kind,
          fileName: row.file.name,
          label: row.label
        });
        // Wait for each file to finish before attaching the next / clicking Next.
        await waitForUploadsToSettle(row.kind === "coverLetter" ? 25000 : 20000);
      } else {
        skipped.push({
          reason: "set-failed",
          kind: row.kind,
          label: row.label
        });
      }
    }

    for (const row of classified) {
      if (row.kind === "other") {
        skipped.push({ reason: "optional-other-files", label: row.label });
      }
    }

    const settled = await waitForUploadsToSettle(8000);
    return { uploadedCount: uploaded.length, uploaded, skipped, settled };
  }

  function looksLikeQuestionLabel(label) {
    const t = String(label || "").trim();
    if (t.length < 12) return false;
    if (t.length > 1200) return false;
    if (/[?]/.test(t)) return true;
    if (
      /^(tell|describe|explain|share|what|why|how|please|list|provide|summarize|walk)\b/i.test(t)
    ) {
      return true;
    }
    if (
      /\b(experience|interested|motivation|challenge|strength|weakness|about yourself|additional|comment|approach|follow.?up|customization|architecture)\b/i.test(
        t
      )
    ) {
      return true;
    }
    return false;
  }

  const EDITOR_PLACEHOLDER_RE =
    /we want to hear from you|please answer based on your own experience|authentic answers help|type here|enter text|write here|your answer|click to (type|enter)|this field is required/i;
  const GENERIC_CLIENT_PROMPT_RE =
    /please answer this question from the client/i;

  function isRichTextEditor(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return false;
    if (el.closest?.('[role="toolbar"], .ql-toolbar, .tox-toolbar, .cke_toolbox, .fr-toolbar')) {
      return false;
    }
    const ce = String(el.getAttribute("contenteditable") || "").toLowerCase();
    if (ce === "true" || ce === "") return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "textbox" && el.getAttribute("aria-multiline") === "true") return true;
    const cls = String(el.className || "");
    return /\b(ql-editor|ck-editor__editable|fr-element|public-DraftEditor-content|ProseMirror|lexical-contenteditable)\b/i.test(
      cls
    );
  }

  function editorPlainText(el) {
    if (!el) return "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      return String(el.value || "").trim();
    }
    return cleanLabelText(el.innerText || el.textContent || "");
  }

  function isEditorEmpty(el) {
    const t = editorPlainText(el);
    if (!t) return true;
    const ph = String(
      el.getAttribute("data-placeholder") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("aria-placeholder") ||
        ""
    ).trim();
    if (ph && normalize(t) === normalize(ph)) return true;
    if (/^(this field is required\.?|required|\u00a0)$/i.test(t)) return true;
    if (EDITOR_PLACEHOLDER_RE.test(t) && t.length < 400) return true;
    return false;
  }

  function scoreQuestionCandidate(text) {
    const t = cleanLabelText(text);
    if (!t || t.length < 8 || t.length > 1200) return -1;
    if (EDITOR_PLACEHOLDER_RE.test(t) && t.length < 400) return -1;
    if (/^(this field is required\.?|required)$/i.test(t)) return -1;
    let score = Math.min(t.length, 220);
    if (/[?]/.test(t)) score += 80;
    if (looksLikeQuestionLabel(t)) score += 40;
    if (GENERIC_CLIENT_PROMPT_RE.test(t) && t.length < 120) score -= 220;
    if (/please confirm which|certifications you currently hold/i.test(t)) score += 60;
    return score;
  }

  function fieldRootForEditor(el) {
    let node = el?.parentElement || null;
    let last = el;
    const editorSel =
      '[contenteditable="true"], [contenteditable=""], .ql-editor, .ck-editor__editable, .fr-element, .public-DraftEditor-content, .ProseMirror';
    while (node) {
      const editors = [...(node.querySelectorAll?.(editorSel) || [])].filter((n) => isRichTextEditor(n));
      if (editors.length > 1) return last;
      last = node;
      const blob = `${node.className || ""} ${node.getAttribute?.("data-automation-id") || ""} ${
        node.getAttribute?.("data-testid") || ""
      }`;
      if (/\b(formfield|form-field|formField|question|applicationquestion|field-wrapper)\b/i.test(blob)) {
        return node;
      }
      node = node.parentElement;
    }
    return last;
  }

  function questionTextNearEditor(el) {
    const candidates = [];
    const push = (value) => {
      const t = cleanLabelText(value);
      if (!t) return;
      const stripped = t
        .replace(GENERIC_CLIENT_PROMPT_RE, " ")
        .replace(/\bthis field is required\b/gi, " ")
        .replace(EDITOR_PLACEHOLDER_RE, " ");
      const core = cleanLabelText(stripped);
      if (core) candidates.push(core);
      candidates.push(t);
    };

    const root = fieldRootForEditor(el);
    push(questionTextForAi(el));
    push(questionLabelForControl(el));
    push(el.getAttribute("aria-label"));
    push(el.getAttribute("data-placeholder"));

    if (root) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, button, svg, [contenteditable], .ql-editor").forEach((n) => {
        if (n !== el) n.remove();
      });
      push(clone.textContent);
      for (const hit of root.querySelectorAll(
        "blockquote, q, em, i, label, legend, h2, h3, h4, p, [class*='question'], [class*='prompt']"
      )) {
        if (hit.contains(el) || el.contains(hit)) continue;
        if (hit.closest("[contenteditable], .ql-editor")) continue;
        push(hit.textContent);
      }
      const prev = root.previousElementSibling;
      if (prev && !prev.querySelector?.("[contenteditable], .ql-editor, input[type='file']")) {
        push(prev.textContent);
      }
    }

    try {
      const frame = window.frameElement;
      if (frame) {
        push(questionTextForAi(frame));
        push(questionLabelForControl(frame));
        push(frame.getAttribute("title"));
        push(frame.getAttribute("aria-label"));
        const hostPrev = frame.previousElementSibling;
        if (hostPrev) push(hostPrev.textContent);
      }
    } catch {
      /* cross-origin iframe */
    }

    let best = "";
    let bestScore = -1;
    for (const c of candidates) {
      const score = scoreQuestionCandidate(c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return String(best || "").slice(0, 1000);
  }

  function fillContentEditable(el, value) {
    const text = String(value || "").trim();
    if (!text || !el) return false;
    try {
      el.focus();
    } catch {
      /* focus is best-effort */
    }

    const insertOk = (() => {
      try {
        document.execCommand("selectAll", false, null);
        return document.execCommand("insertText", false, text);
      } catch {
        return false;
      }
    })();

    const shown = editorPlainText(el);
    if (!insertOk || !shown || EDITOR_PLACEHOLDER_RE.test(shown)) {
      const html = text
        .split(/\n+/)
        .map((p) => `<p>${escapeHtmlText(p)}</p>`)
        .join("");
      try {
        el.innerHTML = html || `<p>${escapeHtmlText(text)}</p>`;
      } catch {
        el.textContent = text;
      }
    }

    try {
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      el.blur();
    } catch {
      /* ignore */
    }

    const root =
      el.closest(
        ".ql-container, .fr-box, .tox-tinymce, .ck-editor, [class*='RichText'], [class*='rich-text'], [class*='editor'], form, fieldset"
      ) || el.parentElement;
    if (root) {
      for (const ta of root.querySelectorAll("textarea")) {
        setNativeValue(ta, text);
      }
    }
    return !isEditorEmpty(el);
  }

  function isMultilineControl(el) {
    if (!el) return false;
    if (isRichTextEditor(el)) return true;
    return el.tagName === "TEXTAREA" || Number(el.rows || 0) > 1;
  }

  function shouldSkipAiField(el, label) {
    const type = (el.type || "text").toLowerCase();
    if (
      ["password", "email", "tel", "url", "number", "date", "month", "week", "time", "color", "range"].includes(
        type
      )
    ) {
      return true;
    }
    // Never send React-Select / Greenhouse dropdowns to AI text fill.
    if (isReactSelectInput(el) || looksLikeCombobox(el)) return true;
    if (el.getAttribute("role") === "combobox") return true;
    if (el.getAttribute("aria-autocomplete") === "list") return true;
    if (el.classList?.contains("select__input")) return true;
    if (/^react-select-/i.test(el.id || "")) return true;

    const blob = normalize(
      [label, el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("placeholder")].join(
        " "
      )
    );
    if (
      /\b(password|otp|captcha|ssn|social security|credit card|card number|cvv|routing|account number|search)\b/.test(
        blob
      )
    ) {
      return true;
    }
    if (String(el.value || "").trim() && !isRichTextEditor(el)) return true;
    if (isRichTextEditor(el) && !isEditorEmpty(el)) return true;
    return false;
  }

  const SKIP_AI_KNOWN_KEYS = new Set([
    "firstName",
    "lastName",
    "email",
    "phone",
    "zipCode",
    "city",
    "state",
    "country",
    "cityCountryOfResidence",
    "workAuthorized",
    "needsSponsorship",
    "postEmploymentRestrictions",
    "workedForCompanyBefore",
    "relatedToEmployee",
    "governmentEmployee",
    "governmentEthicsRecusal",
    "gender",
    "hispanicLatino",
    "raceEthnicity",
    "veteranStatus",
    "disabilityStatus",
    "englishLevel",
    "over18",
    "willingToRelocate",
    "felonyConviction",
    "backgroundCheckConsent",
    "drugTestConsent"
  ]);

  function collectUnmatchedQuestions(applicantInfo = {}) {
    const questions = [];
    const nodes = [...document.querySelectorAll("input, textarea")].filter((el) => {
      const type = (el.type || "text").toLowerCase();
      if (el.tagName === "TEXTAREA") return true;
      if (el.tagName === "INPUT" && ["text", "search", ""].includes(type)) return true;
      return false;
    });

    const richNodes = [
      ...document.querySelectorAll(
        '[contenteditable="true"], [contenteditable=""], [role="textbox"][aria-multiline="true"], .ql-editor, .ck-editor__editable, .fr-element, .public-DraftEditor-content, .ProseMirror'
      )
    ].filter((el) => {
      if (!isRichTextEditor(el)) return false;
      const inner = el.querySelector(
        '[contenteditable="true"], .ql-editor, .ProseMirror, .ck-editor__editable, .fr-element'
      );
      if (inner && inner !== el) return false;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 40) return false;
      } catch {
        return false;
      }
      return true;
    });

    const all = [...richNodes, ...nodes];

    for (const el of all) {
      // Hard skip Greenhouse / React-Select — never AI-fill dropdown search inputs.
      if (!isRichTextEditor(el) && (isReactSelectInput(el) || looksLikeCombobox(el))) continue;

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.disabled || el.readOnly) continue;

      if (isHistoryFilled(el)) continue;
      const rich = isRichTextEditor(el);
      if (rich && !isEditorEmpty(el)) continue;

      const labelNorm = labelTextForControl(el);
      const questionLabel = rich ? questionTextNearEditor(el) : questionTextForAi(el);
      if (!labelNorm && !questionLabel) continue;
      if (shouldSkipAiField(el, labelNorm || questionLabel)) continue;

      const multiline = isMultilineControl(el);
      const key = matchApplicantKeyFromControl(el);
      if (key) {
        const known = applicantInfo[key];
        if (known != null && String(known).trim()) continue;
        if (SKIP_AI_KNOWN_KEYS.has(key) || SELECT_LIKE_KEYS.has(key)) continue;
      }

      const labelForCheck = normalize(questionLabel || labelNorm);
      if (
        /\b(extension|device type|country phone code|phone code|password|captcha|search)\b/.test(
          labelForCheck
        )
      ) {
        continue;
      }

      const questionLike =
        looksLikeQuestionLabel(questionLabel) || looksLikeQuestionLabel(labelNorm) || rich;
      const hasUsefulLabel = String(questionLabel || labelNorm).trim().length >= 3;
      if (!questionLike && !multiline && !hasUsefulLabel) continue;
      if (multiline && !questionLike && String(questionLabel || labelNorm).trim().length < 8) {
        continue;
      }

      if (questions.length >= 25) break;

      const labelForAi = (questionLabel || labelNorm).slice(0, 1000);
      const id = `rbq_${questions.length}_${Math.abs(
        Array.from(labelForAi).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) | 0, 7)
      )}`;
      el.setAttribute("data-resume-bot-qid", id);
      questions.push({
        id,
        label: labelForAi,
        multiline,
        richText: rich,
        fieldType: rich ? "richtext" : el.tagName === "TEXTAREA" ? "textarea" : "text"
      });
    }

    return questions;
  }

  async function fillAiAnswers(answers = []) {
    suppressLearn();
    const filled = [];
    for (const row of answers) {
      const id = String(row?.id || "").trim();
      let answer = String(row?.answer || "").trim();
      if (!id || !answer) continue;
      const el = document.querySelector(`[data-resume-bot-qid="${CSS.escape(id)}"]`);
      if (!el) continue;
      // Combobox / React-Select must never receive free-text AI answers.
      if (isReactSelectInput(el) || looksLikeCombobox(el)) {
        el.removeAttribute("data-resume-bot-qid");
        continue;
      }
      if (/^(yes|no)([.,!]|$)/i.test(answer)) {
        const label = questionLabelForControl(el) || labelTextForControl(el);
        const isChoice = el.type === "checkbox" || el.type === "radio" || el.tagName === "SELECT";
        const yesNoQ =
          /^(are you|do you|have you|will you|can you|did you|were you)\b/i.test(label) ||
          /\b(yes or no|y\/n)\b/i.test(label);
        if (!isChoice && !yesNoQ) {
          el.removeAttribute("data-resume-bot-qid");
          continue;
        }
        answer = answer.charAt(0).toUpperCase() + answer.slice(1);
      }
      if (await fillControl(el, answer, null)) {
        filled.push({ id, label: labelTextForControl(el), preview: answer.slice(0, 80) });
      }
    }
    return { filledCount: filled.length, filled };
  }

  /**
   * Collect novel CHOICE questions (native select / radio / checkbox) that are
   * NOT mapped to a known profile field. These get answered from the Q&A bank
   * (stable, reusable selections) — never from AI.
   */
  async function collectUnmatchedChoiceQuestions() {
    const out = [];
    const groupIds = new Map(); // labelNorm -> id (radio/checkbox groups share one)
    const nodes = [
      ...document.querySelectorAll('select, input[type="radio"], input[type="checkbox"]')
    ];

    for (const el of nodes) {
      if (out.length >= 40) break;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.disabled) continue;
      if (isHistoryFilled(el)) continue;
      if (isReactSelectInput(el)) continue;

      // Known profile / rule fields are handled by the deterministic autofill loop.
      if (matchApplicantKeyFromControl(el)) continue;
      if (!isChoiceControlEmpty(el)) continue;

      const label = captureQuestionText(el);
      if (!label) continue;
      if (LEARN_SENSITIVE_RE.test(label)) continue;
      const labelNorm = normalize(label);
      if (!labelNorm || labelNorm.length < 6) continue;

      const options = collectControlOptions(el);
      if (!options.length) continue;

      const isGroup = el.type === "radio" || el.type === "checkbox";
      if (isGroup && groupIds.has(labelNorm)) {
        el.setAttribute("data-resume-bot-choice-qid", groupIds.get(labelNorm));
        continue;
      }

      const id = `rbc_${out.length}_${Math.abs(
        Array.from(labelNorm).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) | 0, 7)
      )}`;
      el.setAttribute("data-resume-bot-choice-qid", id);
      if (isGroup) groupIds.set(labelNorm, id);
      const fieldType =
        el.tagName === "SELECT"
          ? "select"
          : el.type === "checkbox"
            ? "checkbox"
            : el.type === "radio"
              ? "radio"
              : "select";
      out.push({ id, label: label.slice(0, 1000), options, fieldType });
    }

    const seenLabels = new Set(out.map((q) => normalize(q.label)));
    const comboNodes = [
      ...document.querySelectorAll(
        '[role="combobox"], input.select__input, [aria-haspopup="listbox"]'
      )
    ];
    for (const el of comboNodes) {
      if (out.length >= 40) break;
      if (!looksLikeCombobox(el) && !isReactSelectInput(el)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.disabled) continue;
      if (isHistoryFilled(el)) continue;
      if (matchApplicantKeyFromControl(el)) continue;
      if (String(el.value || "").trim() && !isPlaceholderChoiceValue(el.value)) continue;

      const label = captureQuestionText(el);
      if (!label || LEARN_SENSITIVE_RE.test(label)) continue;
      const labelNorm = normalize(label);
      if (!labelNorm || labelNorm.length < 6 || seenLabels.has(labelNorm)) continue;

      let options = [];
      if (el.getAttribute("aria-expanded") === "true") {
        options = collectVisibleOptions(document)
          .map((node) => cleanLabelText(node.textContent))
          .filter(Boolean)
          .slice(0, 40);
      }
      if (!options.length) {
        try {
          openReactSelect(el);
          const nodesFound = await waitForOptions(8, 90);
          options = nodesFound
            .map((node) => cleanLabelText(node.textContent))
            .filter(Boolean)
            .slice(0, 40);
          // Close menu so the page stays usable while AI answers.
          const input = isReactSelectInput(el) ? el : el.querySelector?.("input") || el;
          if (input) {
            input.dispatchEvent(
              new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" })
            );
          }
        } catch {
          options = [];
        }
      }
      if (!options.length) continue;

      const id = `rbc_${out.length}_${Math.abs(
        Array.from(labelNorm).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) | 0, 7)
      )}`;
      el.setAttribute("data-resume-bot-choice-qid", id);
      seenLabels.add(labelNorm);
      out.push({
        id,
        label: label.slice(0, 1000),
        options,
        fieldType: "combobox"
      });
    }

    return out;
  }

  async function fillChoiceAnswers(answers = []) {
    suppressLearn();
    const filled = [];
    for (const row of answers) {
      const id = String(row?.id || "").trim();
      const answer = String(row?.answer || "").trim();
      if (!id || !answer) continue;
      const els = [
        ...document.querySelectorAll(`[data-resume-bot-choice-qid="${CSS.escape(id)}"]`)
      ];
      if (!els.length) continue;
      let ok = false;
      for (const el of els) {
        if (await fillControl(el, answer, null)) {
          ok = true;
          if (el.tagName === "SELECT") break; // one select is enough
        }
      }
      if (ok) filled.push({ id, preview: answer.slice(0, 80) });
    }
    return { filledCount: filled.length, filled };
  }

  function collectFillableControls() {
    const nodes = [
      ...document.querySelectorAll(
        'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"], .select__control, [class*="select__control"]'
      )
    ];
    return nodes.filter((el) => {
      const type = (el.type || "").toLowerCase();
      if (type === "file") return false;
      if (type === "hidden" || type === "submit" || type === "button") return false;
      // Prefer the inner input over the outer .select__control wrapper when both match.
      if (
        el.classList?.contains("select__control") ||
        /select__control/.test(el.className || "")
      ) {
        const inner = el.querySelector("input.select__input, input[role='combobox'], input");
        if (inner) return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return true;
    });
  }

  function isFieldFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (typeof el.value === "undefined") return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      // Don't require offsetParent — iCIMS / fixed-position layouts often leave
      // it null even when the control is visible and editable.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        const type = (el.type || "").toLowerCase();
        // Hidden file inputs are still usable for programmatic upload.
        if (type !== "file") return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  function setCredentialValue(el, value) {
    if (!el || value == null || String(value) === "") return false;
    try {
      el.focus?.();
    } catch {
      /* focus is best-effort */
    }
    const ok = setNativeValue(el, String(value));
    try {
      el.blur?.();
    } catch {
      /* blur is best-effort */
    }
    return ok;
  }

  function firstCredentialField(selectors, used) {
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (used.has(el)) continue;
        if (isFieldFillable(el)) return el;
      }
    }
    return null;
  }

  /**
   * Fill saved login / sign-up credentials (email, username, password) on an
   * auth / "create a login" section. Only acts when a password field is present,
   * so plain contact-email fields stay with profile autofill. Never submits.
   *
   * iCIMS uses a bare "Login*" field (not always name=username) — match by label too.
   */
  function fillLoginCredentials(credentials = {}) {
    const email = String(credentials.email || "").trim();
    const username = String(credentials.username || "").trim();
    const password = String(credentials.password || "").trim();
    if (!email && !username && !password) return { filledCount: 0, filled: [] };

    const passwordFields = Array.from(
      document.querySelectorAll('input[type="password"]')
    ).filter(isFieldFillable);
    // No password field ⇒ this is not a login/register form; don't touch it.
    if (!passwordFields.length) return { filledCount: 0, filled: [] };

    suppressLearn();
    const filled = [];
    const used = new Set();

    if (password) {
      // Fill the primary password and any confirm-password field with the same value.
      for (const el of passwordFields) {
        if (setCredentialValue(el, password)) {
          used.add(el);
          filled.push("password");
        }
      }
    }

    const loginValue = username || email;

    // Prefer an explicit Login / Username field (iCIMS "Login*") over the contact Email.
    if (loginValue) {
      let loginEl = firstCredentialField(
        [
          'input[autocomplete="username"]',
          'input[name*="login" i]',
          'input[id*="login" i]',
          'input[name*="user" i]',
          'input[id*="user" i]',
          'input[placeholder*="user" i]',
          'input[aria-label*="user" i]',
          'input[placeholder*="login" i]',
          'input[aria-label*="login" i]'
        ],
        used
      );
      if (!loginEl) {
        for (const el of document.querySelectorAll("input")) {
          if (used.has(el) || !isFieldFillable(el)) continue;
          const type = (el.type || "text").toLowerCase();
          if (["password", "hidden", "file", "submit", "button", "checkbox", "radio"].includes(type)) {
            continue;
          }
          const label = normalize(labelTextForControl(el));
          if (!label) continue;
          // Exact-ish "login" / "username" — avoid matching "LinkedIn" etc.
          if (
            label === "login" ||
            label === "username" ||
            label === "user name" ||
            label.startsWith("login ") ||
            /\b(login|username|user name)\b/.test(label)
          ) {
            if (/linkedin|email|password|phone/.test(label)) continue;
            loginEl = el;
            break;
          }
        }
      }
      if (loginEl && setCredentialValue(loginEl, loginValue)) {
        used.add(loginEl);
        filled.push(username ? "username" : "login");
      }
    }

    if (email) {
      const el = firstCredentialField(
        [
          'input[type="email"]',
          'input[autocomplete="email"]',
          'input[name*="email" i]',
          'input[id*="email" i]',
          'input[placeholder*="email" i]',
          'input[aria-label*="email" i]'
        ],
        used
      );
      if (el && setCredentialValue(el, email)) {
        used.add(el);
        filled.push("email");
      }
    }

    return { filledCount: filled.length, filled };
  }

  /** Prefer the profile field; fall back preferredName → firstName. */
  function resolveApplicantValue(applicantInfo, key) {
    const direct = applicantInfo?.[key];
    if (direct != null && String(direct).trim()) return String(direct).trim();
    if (key === "preferredName") {
      const first = applicantInfo?.firstName;
      if (first != null && String(first).trim()) return String(first).trim();
    }
    if (key === "phoneDeviceType") return "mobile";
    if (key === "phoneCountryCode") {
      const country = String(applicantInfo?.country || "").trim();
      if (/united states|usa|\bus\b/i.test(country)) return "United States of America (+1)";
    }
    if (key === "cityCountryOfResidence") {
      const city = String(applicantInfo?.city || "").trim();
      const state = String(applicantInfo?.state || "").trim();
      const country = String(applicantInfo?.country || "").trim();
      const stateLabel = US_STATE_LABELS[state.toUpperCase()] || state;
      const parts = [city, stateLabel, country].filter(Boolean);
      if (parts.length) return parts.join(", ");
    }
    // Sensible defaults for common yes/no compliance questions when profile is blank.
    if (key === "workAuthorized") return "yes";
    if (key === "needsSponsorship") return "no";
    if (key === "postEmploymentRestrictions") return "no";
    if (key === "workedForCompanyBefore") return "no";
    if (key === "relatedToEmployee") return "no";
    if (key === "governmentEmployee") return "no";
    if (key === "governmentEthicsRecusal") return "no";
    return "";
  }

  function isPlaceholderChoiceValue(text) {
    const t = cleanLabelText(text);
    return !t || /^(select one|please select|choose|--|-)$/i.test(t);
  }

  function isChoiceControlEmpty(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opt = el.options?.[el.selectedIndex];
      const t = cleanLabelText(opt?.textContent || opt?.value || "");
      return isPlaceholderChoiceValue(t);
    }
    if (el.type === "radio" && el.name) {
      const checked = document.querySelector(
        `input[type="radio"][name="${CSS.escape(el.name)}"]:checked`
      );
      return !checked;
    }
    if (el.type === "checkbox") return !el.checked;
    return false;
  }

  function collectControlOptions(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      return [...el.options]
        .map((o) => cleanLabelText(o.textContent || o.value || ""))
        .filter((t) => !isPlaceholderChoiceValue(t));
    }
    if (el.type === "radio" && el.name) {
      const opts = [];
      const seen = new Set();
      for (const r of document.querySelectorAll(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`
      )) {
        const wrap = r.closest("label");
        let t = wrap ? cleanLabelText(wrap.textContent) : cleanLabelText(r.value || "");
        if (wrap) {
          const clone = wrap.cloneNode(true);
          clone.querySelectorAll("input").forEach((n) => n.remove());
          t = cleanLabelText(clone.textContent);
        }
        if (!t) t = cleanLabelText(r.getAttribute("aria-label") || r.value || "");
        const norm = normalize(t);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        opts.push(t);
      }
      return opts;
    }
    if (el.type === "checkbox") return ["Yes", "No"];
    return [];
  }

  /** Second pass: fill empty dropdowns/radios using profile defaults + rule-based keys. */
  async function fillRemainingChoiceControls(applicantInfo = {}) {
    const filled = [];
    const handledRadioGroups = new Set();
    const nodes = [
      ...document.querySelectorAll('select, input[type="radio"], input[type="checkbox"]')
    ];

    for (const el of nodes) {
      if (el.disabled) continue;
      if (isHistoryFilled(el)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.type === "radio" && el.name) {
        if (handledRadioGroups.has(el.name)) continue;
        handledRadioGroups.add(el.name);
        if (!isChoiceControlEmpty(el)) continue;
      } else if (!isChoiceControlEmpty(el)) {
        continue;
      }

      const key = matchApplicantKeyFromControl(el);
      if (!key) continue;
      const value = resolveApplicantValue(applicantInfo, key);
      if (!value) continue;
      if (await fillControl(el, value, key)) {
        filled.push({ key, label: questionLabelForControl(el) });
      }
    }
    return { filledCount: filled.length, filled };
  }

  function markHistoryFilled(el) {
    if (!el) return;
    el.setAttribute("data-resume-bot-history", "1");
  }

  function isHistoryFilled(el) {
    return el?.getAttribute?.("data-resume-bot-history") === "1";
  }

  function historyContext(el) {
    const parts = [
      questionLabelForControl(el),
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("placeholder") || "",
      el.name || "",
      el.id || ""
    ];
    let node = el.parentElement;
    for (let i = 0; i < 4 && node; i += 1) {
      const aria = node.getAttribute?.("aria-label") || "";
      if (aria) parts.push(aria);
      const kid = node.querySelector(
        ":scope > legend, :scope > label, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > p, :scope > span"
      );
      if (kid) parts.push(String(kid.textContent || "").slice(0, 120));
      node = node.parentElement;
    }
    return normalize(parts.filter(Boolean).join(" "));
  }

  function classifyHistoryField(el, sectionKind) {
    const type = (el.type || "").toLowerCase();
    const label = normalize(questionLabelForControl(el) || labelTextForControl(el));
    const ctx = `${label} ${historyContext(el)}`;
    const isCheck = type === "checkbox" || type === "radio";

    if (/\b(street|address line|zip|postal|ssn|password|salary|compensation)\b/.test(ctx)) {
      return null;
    }

    if (
      isCheck &&
      /\b(currently (work|employed)|i currently work|current (job|position|role|employer)|still work here)\b/.test(
        ctx
      )
    ) {
      return "current";
    }

    if (sectionKind === "education") {
      if (/\b(school|university|college|institution)\b/.test(ctx) && !/\b(email|phone)\b/.test(ctx)) {
        return "school";
      }
      if (/\b(field of study|major|concentration|area of study)\b/.test(ctx)) return "fieldOfStudy";
      if (/\b(degree|diploma)\b/.test(ctx)) return "degree";
    }

    if (sectionKind === "work") {
      if (/\b(company|employer|organization|organisation)\b/.test(ctx) && !/\b(email|phone|website)\b/.test(ctx)) {
        return "company";
      }
      if (
        /^(title|role|position)$/.test(label) ||
        /\b(job title|position title|role title|title of (the )?(job|role|position)|position held)\b/.test(ctx)
      ) {
        return "title";
      }
      if (
        /\b(job location|work location|employment location)\b/.test(ctx) ||
        (/^(location|city)$/.test(label) && !/\b(address|street|home)\b/.test(ctx))
      ) {
        return "location";
      }
    }

    const startish = /\b(start|from|begin|beginning|date from)\b/.test(ctx);
    const endish = /\b(end|to|through|until|till|date to|finish)\b/.test(ctx) && !/\b(together|today)\b/.test(ctx);
    const monthish =
      /^(month)$/.test(label) ||
      /\b(start month|end month|from month|to month|month)\b/.test(ctx);
    const yearish =
      /^(year)$/.test(label) ||
      /\b(start year|end year|from year|to year|year)\b/.test(ctx);

    if (monthish && startish && !endish) return "startMonth";
    if (monthish && endish && !startish) return "endMonth";
    if (yearish && startish && !endish) return "startYear";
    if (yearish && endish && !startish) return "endYear";
    if (monthish) return "month";
    if (yearish) return "year";

    if (/\b(start date|from date|begin date|date from|starting date)\b/.test(ctx)) return "startDate";
    if (/\b(end date|to date|through date|date to|ending date|finish date)\b/.test(ctx)) return "endDate";

    if (
      el.tagName === "TEXTAREA" ||
      /\b(description|summary|responsibilities|highlights|duties|role overview|job details)\b/.test(ctx)
    ) {
      if (sectionKind === "work" || /\b(job|role|position|experience|employment)\b/.test(ctx)) {
        return "summary";
      }
    }

    return null;
  }

  function assignDateSlots(slot, kind, el) {
    if (kind === "month") {
      if (!slot.startMonth) slot.startMonth = el;
      else if (!slot.endMonth) slot.endMonth = el;
      return;
    }
    if (kind === "year") {
      if (!slot.startYear) slot.startYear = el;
      else if (!slot.endYear) slot.endYear = el;
      return;
    }
    if (!slot[kind]) slot[kind] = el;
  }

  function collectHistoryGroups(scope, sectionKind) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const controls = collectFillableControls().filter((el) => root === document || root.contains(el));
    const fields = [];
    for (const el of controls) {
      const kind = classifyHistoryField(el, sectionKind);
      if (!kind) continue;
      fields.push({ el, kind });
    }
    if (!fields.length) return [];

    const identity = sectionKind === "education" ? "school" : "company";
    const groups = [];
    let slot = {};
    for (const field of fields) {
      const startsNew =
        (field.kind === identity && slot[identity]) ||
        (field.kind === "title" && slot.title && (slot.company || slot.school));
      if (startsNew) {
        groups.push(slot);
        slot = {};
      }
      assignDateSlots(slot, field.kind, field.el);
    }
    if (Object.keys(slot).length) groups.push(slot);
    return groups.filter((g) =>
      sectionKind === "education" ? g.school || g.degree : g.company || g.title
    );
  }

  function findHistorySectionScope(sectionKind) {
    const re =
      sectionKind === "education"
        ? /\b(education|academic|school history|schools)\b/i
        : /\b(work (history|experience)|employment( history)?|professional experience|experience)\b/i;
    const nodes = [
      ...document.querySelectorAll("h1, h2, h3, h4, h5, legend, [role='heading'], label, p, span, div")
    ];
    for (const node of nodes) {
      if (!isElVisible(node)) continue;
      const text = cleanLabelText(node.textContent || "");
      if (!text || text.length > 80) continue;
      if (!re.test(text)) continue;
      const section = node.closest("section, fieldset, form, [role='group'], [class*='section'], [class*='experience'], [class*='education']");
      if (section && section.querySelectorAll("input, select, textarea").length >= 2) return section;
      const parent = node.parentElement;
      if (parent && parent.querySelectorAll("input, select, textarea").length >= 2) return parent;
    }
    return null;
  }

  function findAddHistoryButton(scope, sectionKind) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const re =
      sectionKind === "education"
        ? /\badd(\s+(another|an|a))?\s*(education|school|degree|institution)\b|\badd another\b/i
        : /\badd(\s+(another|an|a))?\s*(job|position|role|experience|employer|work)\b|\badd another\b|\badd an? (item|entry)\b/i;
    const buttons = [
      ...root.querySelectorAll('button, a, [role="button"], input[type="button"]')
    ].filter((el) => isElVisible(el) && isElEnabled(el));
    return (
      buttons.find((el) => re.test(elActionText(el))) ||
      buttons.find((el) => /^add$/i.test(elActionText(el)) && /experience|education|employment|history/i.test(historyContext(el)))
    );
  }

  async function ensureHistoryGroups(sectionKind, needed) {
    const headingScope = findHistorySectionScope(sectionKind);
    const scope = headingScope || document;
    let groups = collectHistoryGroups(scope, sectionKind);
    if (!groups.length) return groups;
    const want = Math.min(Math.max(1, Number(needed) || 1), 8);
    if (!headingScope) return groups;
    for (let i = 0; i < 8 && groups.length < want; i += 1) {
      const btn = findAddHistoryButton(headingScope, sectionKind);
      if (!btn) break;
      scrollElIntoView(btn);
      btn.click();
      await sleep(550);
      groups = collectHistoryGroups(headingScope, sectionKind);
    }
    return groups;
  }

  function historyDateValues(bundle = {}, extra = []) {
    const out = [];
    for (const v of [
      ...(Array.isArray(bundle.candidates) ? bundle.candidates : []),
      bundle.month,
      bundle.monthShort,
      bundle.monthNum,
      bundle.year,
      bundle.isoMonth,
      bundle.isoDate,
      bundle.display,
      ...extra
    ]) {
      const s = String(v || "").trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  async function fillHistoryValue(el, values) {
    if (!el) return false;
    const list = Array.isArray(values) ? values : [values];
    for (const value of list) {
      if (value == null || String(value).trim() === "") continue;
      if (await fillControl(el, String(value).trim(), null)) {
        markHistoryFilled(el);
        return true;
      }
    }
    return false;
  }

  async function fillOneHistoryGroup(slot, entry, sectionKind) {
    const filled = [];
    const tryFill = async (kind, values) => {
      const el = slot[kind];
      if (!el || isHistoryFilled(el)) return;
      if (await fillHistoryValue(el, values)) filled.push(kind);
    };

    if (sectionKind === "education") {
      await tryFill("school", [entry.school]);
      await tryFill("degree", [entry.degree]);
      await tryFill("fieldOfStudy", [entry.fieldOfStudy, entry.degree]);
    } else {
      await tryFill("company", [entry.company]);
      await tryFill("title", [entry.title]);
      await tryFill("location", [entry.location]);
      await tryFill("summary", [entry.summary]);
    }

    await tryFill("startMonth", historyDateValues(entry.start));
    await tryFill("startYear", [entry.start?.year, entry.start?.display]);
    await tryFill("startDate", historyDateValues(entry.start));
    await tryFill("month", historyDateValues(entry.start));
    await tryFill("year", [entry.start?.year]);

    if (entry.current && slot.current) {
      const el = slot.current;
      if (el.type === "checkbox" && !el.checked) el.click();
      else await fillHistoryValue(el, ["yes", "Yes", "Present"]);
      markHistoryFilled(el);
      filled.push("current");
      await tryFill("endDate", ["Present", "Current"]);
    } else {
      await tryFill("endMonth", historyDateValues(entry.end));
      await tryFill("endYear", [entry.end?.year, entry.end?.display]);
      await tryFill("endDate", historyDateValues(entry.end));
    }

    return filled;
  }

  async function fillHistorySections(workHistory = [], educationHistory = []) {
    const filled = [];
    const jobs = Array.isArray(workHistory) ? workHistory : [];
    const schools = Array.isArray(educationHistory) ? educationHistory : [];

    if (jobs.length) {
      const groups = await ensureHistoryGroups("work", jobs.length);
      const count = Math.min(groups.length, jobs.length);
      for (let i = 0; i < count; i += 1) {
        const kinds = await fillOneHistoryGroup(groups[i], jobs[i], "work");
        if (kinds.length) filled.push({ key: `workHistory[${i}]`, label: jobs[i].company || jobs[i].title });
      }
    }

    if (schools.length) {
      const groups = await ensureHistoryGroups("education", schools.length);
      const use = groups.length ? groups : collectHistoryGroups(document, "education");
      const count = Math.min(use.length, schools.length);
      for (let i = 0; i < count; i += 1) {
        const kinds = await fillOneHistoryGroup(use[i], schools[i], "education");
        if (kinds.length) filled.push({ key: `education[${i}]`, label: schools[i].school || schools[i].degree });
      }
    }

    return filled;
  }

  function looksLikeHistoryForm() {
    const work = collectHistoryGroups(document, "work");
    const edu = collectHistoryGroups(document, "education");
    return work.length > 0 || edu.length > 0;
  }

  async function autofillApplication(
    applicantInfo = {},
    uploadFiles = {},
    credentials = {},
    history = {}
  ) {
    suppressLearn();
    const filled = [];

    // Top → bottom: attach docs first and wait for the host to finish ingesting
    // them before filling fields or clicking Next (avoids Dice "Leave site?" prompts).
    const uploadResult = await uploadApplicationFiles(uploadFiles);

    const historyFilled = await fillHistorySections(history.workHistory, history.educationHistory);
    for (const row of historyFilled) filled.push(row);

    const controls = collectFillableControls();

    for (const el of controls) {
      if (isHistoryFilled(el)) continue;
      const label = labelTextForControl(el);
      const key = matchApplicantKeyFromControl(el);
      if (!key) continue;
      const value = resolveApplicantValue(applicantInfo, key);
      if (!value) continue;
      if (await fillControl(el, value, key)) filled.push({ key, label });
    }

    const choicePass = await fillRemainingChoiceControls(applicantInfo);
    for (const row of choicePass.filled || []) filled.push(row);

    // Fill saved login/sign-up credentials when this page has a Create Login section.
    const creds = {
      email: String(credentials.email || applicantInfo.email || "").trim(),
      username: String(credentials.username || "").trim(),
      password: String(credentials.password || "")
    };
    const credResult = fillLoginCredentials(creds);

    // One more quiet check so Next is never pressed mid-upload.
    if (uploadResult.uploadedCount > 0 || uploadsStillBusy()) {
      await waitForUploadsToSettle(12000);
    }

    const unmatchedQuestions = collectUnmatchedQuestions(applicantInfo);
    const unmatchedChoiceQuestions = await collectUnmatchedChoiceQuestions();

    return {
      ok: true,
      filledCount: filled.length,
      filled,
      credentialFilledCount: credResult.filledCount,
      credentialFilled: credResult.filled,
      uploadedCount: uploadResult.uploadedCount,
      uploaded: uploadResult.uploaded,
      uploadSkipped: uploadResult.skipped,
      uploadsSettled: uploadResult.settled !== false && !uploadsStillBusy(),
      unmatchedQuestions,
      unmatchedChoiceQuestions
    };
  }

  function collectApplyUrlCandidates() {
    const applyUrls = [];
    const seen = new Set();

    const applyRe = isDiceJobBrowsePage()
      ? /\beasy\s*apply\b|\bapply(\s+now)?\b/i
      : /\beasy\s*apply\b|\bapply now\b|\bstart application\b|\bbegin application\b/i;

    function pushUrl(href) {
      const url = String(href || "").trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) return;
      if (seen.has(url)) return;
      if (isDiceJobBrowsePage() && !/\/job-applications\b|\/job-detail\b|\/wizard\b|easy-apply/i.test(url)) {
        return;
      }
      try {
        const here = location.href.replace(/#.*$/, "");
        if (url.replace(/#.*$/, "") === here) return;
      } catch {
        /* ignore */
      }
      seen.add(url);
      applyUrls.push(url);
    }

    for (const a of document.querySelectorAll("a[href]")) {
      try {
        const text = String(a.textContent || a.getAttribute("aria-label") || "").trim();
        if (applyRe.test(text)) pushUrl(a.href);
      } catch {
        /* ignore */
      }
      if (applyUrls.length >= 5) break;
    }

    if (applyUrls.length < 5) {
      for (const el of document.querySelectorAll("button[formaction], input[type='submit'][formaction]")) {
        try {
          const href = el.getAttribute("formaction");
          if (href) pushUrl(href);
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    if (applyUrls.length < 5) {
      for (const btn of document.querySelectorAll("button, input[type='button']")) {
        try {
          const text = String(btn.textContent || btn.getAttribute("aria-label") || "").trim();
          if (!applyRe.test(text)) continue;
          const href = btn.getAttribute("data-href") || btn.getAttribute("data-url") || "";
          if (href) pushUrl(href);
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    if (applyUrls.length < 5 && /(^|\.)dice\.com$/i.test(location.hostname)) {
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          if (/\/job-applications\b|\/apply\b|easy-apply|application\/apply/i.test(a.href || "")) {
            pushUrl(a.href);
          }
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    return applyUrls;
  }

  function detectPageBlocker() {
    if (document.querySelector('input[type="password"]')) {
      return "A sign-in form is on the page. Log in, then retry.";
    }
    if (
      document.querySelector(
        '.g-recaptcha, #g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
      )
    ) {
      return "A CAPTCHA is on the page. Solve it, then retry.";
    }
    return "";
  }

  // Phrases that mean the posting is gone (expired / filled / removed / 404).
  const JOB_GONE_RE = new RegExp(
    [
      "sorry[, ]*this job is no longer available",
      "this job is no longer available[.!]?(?:\\s*the similar jobs shown below)?",
      "similar jobs shown below might interest you",
      "this job has closed",
      "no longer (available|accepting applications|active|open|exists)",
      "(job|position|posting|listing|role|opening|opportunity) (is |has been )?(no longer|not) (available|active|open)",
      "(position|role|job) (has been |is )?(filled|closed)",
      "(posting|job posting|application|applications|listing) (has |have )?(now )?(expired|closed|ended)",
      "we (are|'re) no longer accepting",
      "this (job|position|posting|listing) (has expired|is closed|was removed|has been removed|no longer exists)",
      "(job|page) not found",
      "this listing has been removed",
      "404 error|error 404",
      "couldn'?t find (this|that|the) (job|page|posting)",
      "the (job|position) you(?:'| a)?re looking for"
    ].join("|"),
    "i"
  );

  function unavailableTextSnippet() {
    const parts = [];
    const title = String(document.title || "");
    if (title) parts.push(title);
    const nodes = document.querySelectorAll(
      [
        "h1",
        "h2",
        '[role="heading"]',
        '[role="alert"]',
        '[role="status"]',
        ".error",
        '[class*="error"]',
        '[class*="alert"]',
        '[class*="banner"]',
        '[class*="notice"]',
        '[class*="not-found"]',
        '[class*="notFound"]',
        '[class*="expired"]',
        '[class*="expired-text"]',
        '[class*="index_expired-text"]',
        '[class*="unavailable"]',
        '[class*="empty-state"]',
        '[class*="job-closed"]',
        '[class*="jobClosed"]',
        '[data-testid*="closed"]',
        '[data-testid*="unavailable"]'
      ].join(", ")
    );
    let count = 0;
    for (const el of nodes) {
      const t = cleanLabelText(el.textContent);
      if (t && t.length <= 400) parts.push(t);
      if (++count > 60) break;
    }
    // Dice / ATS closed banners often live in plain body copy, not headings.
    const body = String(document.body?.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
    if (body) parts.push(body);
    return parts.join("  ").slice(0, 10000);
  }

  /** Jobright closed badge: span.index_expired-text* → "This job has closed." */
  function detectJobrightExpiredBadge() {
    const host = String(location.hostname || "").toLowerCase();
    if (!host.includes("jobright.ai")) return "";

    const nodes = document.querySelectorAll(
      '[class*="index_expired-text"], [class*="expired-text"]'
    );
    for (const el of nodes) {
      if (!el) continue;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch {
        /* ignore */
      }
      const text = cleanLabelText(el.textContent);
      if (!text) continue;
      if (/this job has closed|job has closed|no longer available|expired/i.test(text)) {
        return text.slice(0, 140) || "This job has closed.";
      }
    }
    return "";
  }

  /** @returns {string} a short reason when the job is gone, else "" */
  function detectJobUnavailable() {
    const jobrightClosed = detectJobrightExpiredBadge();
    if (jobrightClosed) return jobrightClosed;

    const match = unavailableTextSnippet().match(JOB_GONE_RE);
    if (match) {
      return cleanLabelText(match[0]).slice(0, 140) || "This job is no longer available.";
    }
    return "";
  }

  /**
   * Decide whether this page is really an application form. Job search / listing
   * pages also contain inputs (search boxes, filters), so field count alone is
   * not enough to justify autofilling.
   */
  function probeApplicationForm() {
    const controls = collectFillableControls();
    const fillableCount = controls.length;

    const hasFileInput = collectFileInputs().length > 0;

    let identityFields = 0;
    let filterFields = 0;
    for (const el of controls) {
      const key = matchApplicantKeyFromControl(el);
      if (!key) continue;
      if (["firstName", "lastName", "email", "phone", "linkedinUrl", "addressLine1"].includes(key)) {
        identityFields += 1;
      } else {
        filterFields += 1;
      }
    }

    const hasApplyForm = [...document.querySelectorAll("form")].some((form) => {
      const blob = normalize(
        [form.getAttribute("action"), form.getAttribute("id"), form.className].join(" ")
      );
      return /appl(y|ication)|candidate|submission/.test(blob);
    });

    const pathAndQuery = `${location.pathname || ""}${location.search || ""}`;
    const isDiceHost = /(^|\.)dice\.com$/i.test(location.hostname);
    const isDiceApplyPage =
      isDiceHost &&
      /\/job-applications\b|\/wizard\b|easy-apply/i.test(pathAndQuery);

    // Dice job cards / job-detail pages have newsletter and ad forms. Those are
    // not the application. Only the /job-applications wizard is.
    const isApplicationForm = isDiceHost
      ? Boolean(isDiceApplyPage)
      : Boolean(
          hasFileInput ||
            identityFields >= 2 ||
            (hasApplyForm && fillableCount >= 2) ||
            looksLikeHistoryForm()
        );

    return {
      ok: true,
      hasFormFields: fillableCount >= 1,
      isApplicationForm,
      fillableCount,
      identityFields,
      filterFields,
      hasFileInput,
      blockedReason: detectPageBlocker(),
      jobUnavailable: detectJobUnavailable(),
      alreadyApplied: detectDiceAlreadyApplied(),
      applyUrls: collectApplyUrlCandidates()
    };
  }

  // ---- Multi-step Auto Apply (any ATS / Dice / Jobright) ---------------------

  const EASY_NEXT_RE =
    /\b(next(\s+step)?|continue|save\s*(and|&)\s*continue|save\s*(and|&)\s*next|agree\s*(and|&)\s*continue|proceed|forward)\b/i;
  const EASY_REVIEW_RE = /\b(review(\s+(application|answers|info|information))?|preview)\b/i;
  const EASY_SUBMIT_RE =
    /\b(submit(\s+(your\s+)?(application|app))?|send(\s+(your\s+)?application)?|finish(\s+application)?|complete(\s+application)?|apply\s+now|confirm(\s+(and|&)\s+submit)?)\b/i;
  const APPLY_SUCCESS_RE = new RegExp(
    [
      "awesome!?\\s*your application is on its way",
      "your application is on its way",
      "your application has been submitted",
      "application submitted successfully",
      "successfully submitted your application",
      "thank you for (your )?appl(y|ication)",
      "application (was |has been )?sent",
      "we('ve| have) received your application"
    ].join("|"),
    "i"
  );

  function isDiceApplicationPath(url = location.href) {
    try {
      const u = new URL(String(url || ""), location.href);
      if (!/(^|\.)dice\.com$/i.test(u.hostname)) return false;
      return /\/job-applications\b|\/wizard\b|easy-apply/i.test(`${u.pathname}${u.search}`);
    } catch {
      return false;
    }
  }

  function isDiceJobBrowsePage(url = location.href) {
    try {
      const u = new URL(String(url || ""), location.href);
      if (!/(^|\.)dice\.com$/i.test(u.hostname)) return false;
      return !isDiceApplicationPath(u.href);
    } catch {
      return false;
    }
  }

  function detectApplicationSuccess() {
    const href = String(location.href || "");
    const path = String(location.pathname || "");
    if (
      /\/wizard\/success(?:\/|$)/i.test(path) ||
      /\/job-applications\/[^/]+\/(?:wizard\/)?success\b/i.test(path) ||
      /\/apply\/success\b/i.test(path)
    ) {
      return "Application submitted (confirmation page).";
    }
    if (/[?&](?:status|result)=success\b/i.test(href)) {
      return "Application submitted (confirmation page).";
    }
    const blob = `${document.title || ""}\n${document.body?.innerText || ""}`.slice(0, 12000);
    const match = blob.match(APPLY_SUCCESS_RE);
    return match ? cleanLabelText(match[0]).slice(0, 160) : "";
  }
  const EASY_BACK_RE = /\b(back|previous|cancel|close|dismiss|return)\b/i;
  const ENTRY_JUNK_RE =
    /\b(cancel|close|dismiss|skip|not now|maybe later|show ad|show ads|advert|sponsored|cookie|subscribe|sign in|log in|register|learn more|see more|next job|previous job|watch|play video)\b/i;
  const EASY_APPLY_TEXT_RE =
    /^\s*(easy\s*apply|1-?click apply|one-?click apply|quick apply)\s*$/i;
  const APPLY_ONLY_TEXT_RE = /^\s*(apply(\s+now)?|apply with dice)\s*$/i;
  const ALREADY_APPLIED_TEXT_RE = /^\s*applied\s*$/i;
  const EASY_ENTRY_RE =
    /\b(easy apply|1-?click apply|one-?click apply|quick apply|apply with|apply now|apply)\b/i;

  function elActionText(el) {
    return cleanLabelText(
      el.textContent || el.value || el.getAttribute?.("aria-label") || ""
    );
  }

  function isElVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isElEnabled(el) {
    return !el.disabled && el.getAttribute?.("aria-disabled") !== "true";
  }

  function scrollElIntoView(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch {
      /* ignore */
    }
  }

  function getDiceWizardRoot() {
    if (!isDiceApplicationPath()) return null;
    const selectors = [
      '[data-testid*="wizard"]',
      '[data-testid*="application-wizard"]',
      '[class*="application-wizard"]',
      '[class*="ApplicationWizard"]',
      '[class*="job-application"]',
      '[class*="JobApplication"]',
      '[id*="job-application"]',
      'form[action*="job-application"]',
      'form'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.querySelector("button, [role='button'], input[type='submit']")) return el;
    }
    // Prefer main content without the site header/avatar chrome.
    const main = document.querySelector('main, [role="main"], #content, #main');
    if (main && main.querySelector("button, [role='button'], input[type='submit']")) return main;
    return document;
  }

  /** Header / avatar / account menu — never treat as Apply / Next / Submit. */
  function isSiteChromeControl(el) {
    if (!el || typeof el.closest !== "function") return true;

    const href = String(el.href || el.getAttribute?.("href") || el.getAttribute?.("data-href") || "");
    if (/dice\.com\/(profile|account|settings|dashboard|preferences)\b/i.test(href)) return true;
    if (/^https?:\/\/([^/]*\.)?dice\.com\/(profile|account|settings|dashboard|preferences)\b/i.test(href)) {
      return true;
    }
    if (/\/(dashboard|settings|profile|account|preferences)(\/|\?|#|$)/i.test(href)) return true;

    // Avatar / account menus (global nav) — these open /profile.
    if (
      el.closest(
        [
          '[data-testid*="avatar" i]',
          '[class*="avatar"]',
          '[class*="Avatar"]',
          '[data-testid*="user-menu" i]',
          '[data-testid*="account-menu" i]',
          '[data-testid*="profile-menu" i]',
          '[aria-label*="account menu" i]',
          '[aria-label*="user menu" i]',
          '[aria-label*="my profile" i]',
          '[aria-label*="view profile" i]',
          'a[href*="/profile"]',
          'a[href*="/account"]',
          'a[href*="/settings"]',
          'a[href*="/dashboard"]',
          'a[href*="/preferences"]'
        ].join(", ")
      )
    ) {
      return true;
    }

    const text = elActionText(el);
    if (/\b(my profile|account settings|view profile|edit profile)\b/i.test(text)) return true;

    // Only treat the TOP site banner/nav as chrome. Job-detail panes often wrap
    // their own <header> around the teal Apply button — do NOT exclude that.
    const inJobSurface = Boolean(
      el.closest(
        [
          '[data-testid*="job-detail" i]',
          '[data-testid*="jobDetail" i]',
          '[class*="job-detail"]',
          '[class*="JobDetail"]',
          '[class*="jobDetail"]',
          '[class*="job-description"]',
          '[class*="JobDescription"]',
          '[class*="search-detail"]',
          '[class*="SearchDetail"]',
          '[class*="details-pane"]',
          '[class*="DetailsPane"]',
          '[class*="job-view"]',
          '[class*="JobView"]'
        ].join(", ")
      )
    );
    if (inJobSurface) return false;

    const banner = el.closest('header, [role="banner"], nav, [role="navigation"]');
    if (banner) {
      try {
        const top = banner.getBoundingClientRect().top;
        // Global Dice nav sits at the very top of the viewport.
        if (top < 96) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  function actionButtonScore(btn, type) {
    let score = type === "submit" ? 30 : type === "review" ? 20 : 10;
    const hint = `${btn.getAttribute("data-testid") || ""} ${btn.id || ""} ${btn.className || ""}`;
    if (new RegExp(type, "i").test(hint)) score += 40;
    if (/next|continue|submit|review|wizard|footer|action/i.test(hint)) score += 25;
    if (
      btn.closest(
        '[class*="footer"], [class*="Footer"], [data-testid*="footer"], [class*="wizard-action"], [class*="step-action"], [class*="form-action"], [class*="sticky"]'
      )
    ) {
      score += 80;
    }
    if (isSiteChromeControl(btn)) score -= 250;
    if (isInsideAdOrOverlay(btn)) score -= 200;
    try {
      const top = btn.getBoundingClientRect().top;
      // Wizard Next/Submit sit near the bottom of the viewport.
      score += Math.max(0, Math.min(50, Math.floor(top / 16)));
    } catch {
      /* ignore */
    }
    return score;
  }

  /** The most form-dense visible dialog/modal, or the document when none. */
  function getApplyScope() {
    if (isDiceApplicationPath()) {
      return getDiceWizardRoot() || document;
    }
    if (isDiceJobBrowsePage()) {
      return document;
    }
    const sel =
      '[role="dialog"], dialog[open], dialog, [aria-modal="true"], .modal, [class*="modal"], [class*="apply"], [id*="apply"]';
    let best = null;
    let bestCount = -1;
    for (const node of document.querySelectorAll(sel)) {
      if (!isElVisible(node)) continue;
      const count = node.querySelectorAll("input, textarea, select, button").length;
      if (count > bestCount) {
        best = node;
        bestCount = count;
      }
    }
    return best || document;
  }

  function isInsideAdOrOverlay(el) {
    if (!el || typeof el.closest !== "function") return false;
    return Boolean(
      el.closest(
        [
          '[class*="ad-"]',
          '[class*="adsby"]',
          '[id*="google_ads"]',
          "[data-ad]",
          '[class*="sponsor"]',
          '[class*="cookie"]',
          '[id*="cookie"]',
          "aside[class*='ad']"
        ].join(", ")
      )
    );
  }

  /** Dice job detail: the teal button already says "Applied". */
  function detectDiceAlreadyApplied() {
    if (!/(^|\.)dice\.com$/i.test(location.hostname)) return "";
    if (isDiceApplicationPath()) return "";

    const controls = [
      ...document.querySelectorAll("button, a, [role='button'], span, div")
    ];
    for (const el of controls) {
      if (!isElVisible(el)) continue;
      if (isSiteChromeControl(el) || isInsideAdOrOverlay(el)) continue;
      const text = elActionText(el);
      if (!ALREADY_APPLIED_TEXT_RE.test(text)) continue;

      // Prefer the job-detail pane CTA; still accept a clear Applied control.
      const inDetail = Boolean(
        el.closest(
          '[data-testid*="job-detail" i], [class*="job-detail"], [class*="JobDetail"], [class*="search-detail"], [class*="details-pane"], [class*="job-view"]'
        )
      );
      try {
        const rect = el.getBoundingClientRect();
        if (inDetail || rect.left > window.innerWidth * 0.3) {
          return "Already applied on Dice (button shows Applied).";
        }
      } catch {
        if (inDetail) return "Already applied on Dice (button shows Applied).";
      }
    }
    return "";
  }

  /** Dice search/detail: the teal Apply button in the job detail panel (top-right). */
  function findDiceJobDetailApplyButton() {
    if (!/(^|\.)dice\.com$/i.test(location.hostname)) return null;
    if (isDiceApplicationPath()) return null;

    const controls = [...document.querySelectorAll("button, a, [role='button']")].filter(
      (el) => isElVisible(el) && isElEnabled(el) && !isSiteChromeControl(el)
    );
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      if (ALREADY_APPLIED_TEXT_RE.test(text)) continue;
      if (!APPLY_ONLY_TEXT_RE.test(text) && !EASY_APPLY_TEXT_RE.test(text)) continue;
      if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(el)) continue;
      const href = String(el.href || el.getAttribute?.("href") || "");
      if (/\/profile\b/i.test(href)) continue;

      let score = EASY_APPLY_TEXT_RE.test(text) ? 120 : 90;
      const hint = `${el.getAttribute("data-testid") || ""} ${el.id || ""} ${el.className || ""}`;
      if (/easy[-_ ]?apply|apply-button|job-detail|jobDetail/i.test(hint)) score += 40;

      // Prefer the right-hand detail pane (Apply sits top-right of that panel).
      try {
        const rect = el.getBoundingClientRect();
        if (rect.left > window.innerWidth * 0.35) score += 50;
        if (rect.top > 60 && rect.top < window.innerHeight * 0.45) score += 35;
        // Big filled CTA, not a tiny icon button.
        if (rect.width >= 72 && rect.height >= 28) score += 25;
      } catch {
        /* ignore */
      }

      if (
        el.closest(
          '[data-testid*="job-detail" i], [class*="job-detail"], [class*="JobDetail"], [class*="search-detail"], [class*="details-pane"], [class*="job-view"]'
        )
      ) {
        score += 60;
      }

      scored.push({ type: "entry", el, text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  function findEasyApplyEntryButton() {
    const diceDetail = findDiceJobDetailApplyButton();
    if (diceDetail) return diceDetail;

    const controls = [...document.querySelectorAll("button, a, [role='button']")].filter(
      (el) => isElVisible(el) && isElEnabled(el) && !isSiteChromeControl(el)
    );
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      if (!text || text.length > 48) continue;
      if (ENTRY_JUNK_RE.test(text) || EASY_BACK_RE.test(text)) continue;
      if (isInsideAdOrOverlay(el)) continue;
      const href = String(el.href || el.getAttribute?.("href") || el.getAttribute?.("data-href") || "");
      if (/\/profile\b|\/account\b|\/settings\b/i.test(href)) continue;
      const hint = `${el.getAttribute("data-testid") || ""} ${el.id || ""} ${el.className || ""} ${href}`;
      let score = 0;
      if (EASY_APPLY_TEXT_RE.test(text) || /easy[-_ ]?apply/i.test(hint)) score = 100;
      else if (APPLY_ONLY_TEXT_RE.test(text) && /job-applications|easy-?apply|apply-button|job-detail/i.test(hint)) {
        score = 70;
      } else if (APPLY_ONLY_TEXT_RE.test(text) && /(^|\.)dice\.com$/i.test(location.hostname)) {
        score = 55;
      } else if (APPLY_ONLY_TEXT_RE.test(text)) {
        score = 40;
      }
      if (score) scored.push({ type: "entry", el, text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  const classifyActionButton = function (text) {
    const t = String(text || "").trim();
    if (!t || t.length > 80) return null;
    if (EASY_NEXT_RE.test(t)) return "next";
    if (EASY_REVIEW_RE.test(t)) return "review";
    if (EASY_SUBMIT_RE.test(t)) return "submit";
    return null;
  };

  const findActionButton = function (scope, { includeDisabledSubmit = false } = {}) {
    const scopeEl = scope || getApplyScope();
    const allButtons = [
      ...scopeEl.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
      )
    ].filter((el) => isElVisible(el) && !isSiteChromeControl(el));
    const buttons = allButtons.filter((el) => isElEnabled(el));

    const candidates = { next: [], review: [], submit: [] };
    for (const btn of buttons) {
      const text = elActionText(btn);
      const typeAttr = String(btn.getAttribute("type") || btn.type || "").toLowerCase();
      const hint = `${btn.getAttribute("data-testid") || ""} ${btn.id || ""} ${btn.className || ""}`;
      if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(btn)) continue;
      if (EASY_BACK_RE.test(text) && !EASY_NEXT_RE.test(text) && !EASY_SUBMIT_RE.test(text)) {
        continue;
      }
      // Ignore job-carousel / listing "Next" while inside the application wizard.
      if (isDiceApplicationPath() && /\b(next job|previous job|next posting)\b/i.test(text)) {
        continue;
      }
      const cls = classifyActionButton(text);
      if (cls && candidates[cls]) {
        candidates[cls].push({ type: cls, el: btn, text, score: actionButtonScore(btn, cls) });
      } else if (
        (typeAttr === "submit" || /submit/i.test(hint)) &&
        !EASY_BACK_RE.test(text)
      ) {
        candidates.submit.push({
          type: "submit",
          el: btn,
          text: text || "Submit",
          score: actionButtonScore(btn, "submit")
        });
      }
    }

    const pickBest = (list) => {
      if (!list.length) return null;
      list.sort((a, b) => b.score - a.score);
      return list[0].score > -100 ? list[0] : null;
    };

    let next = pickBest(candidates.next);
    let review = pickBest(candidates.review);
    let submit = pickBest(candidates.submit);

    // Dice final step often keeps Submit disabled until the SPA settles.
    if (!submit && (includeDisabledSubmit || isDiceApplicationPath())) {
      for (const btn of allButtons) {
        if (isElEnabled(btn)) continue;
        const text = elActionText(btn);
        const typeAttr = String(btn.getAttribute("type") || btn.type || "").toLowerCase();
        const hint = `${btn.getAttribute("data-testid") || ""} ${btn.id || ""} ${btn.className || ""}`;
        const isSubmit =
          classifyActionButton(text) === "submit" ||
          typeAttr === "submit" ||
          /^\s*(submit|apply(\s+now)?)\s*$/i.test(text) ||
          /submit/i.test(hint);
        if (!isSubmit || isInsideAdOrOverlay(btn) || ENTRY_JUNK_RE.test(text)) continue;
        submit = {
          type: "submit",
          el: btn,
          text: text || "Submit",
          disabled: true,
          score: actionButtonScore(btn, "submit")
        };
        break;
      }
    }

    // Dice wizard chrome often still has a "Next" (job carousel). The last
    // application step is Submit — always prefer it when it is on the wizard.
    if (isDiceApplicationPath()) {
      if (submit) return submit;
      if (next) return next;
      if (review) return review;
    } else {
      if (next) return next;
      if (review) return review;
      if (submit) return submit;
    }
    // Final Dice wizard page often labels the last control "Apply".
    if (isDiceApplicationPath() && !detectApplicationSuccess()) {
      const applyBtn = buttons.find((btn) => /^\s*apply(\s+now)?\s*$/i.test(elActionText(btn)));
      if (applyBtn) {
        return { type: "submit", el: applyBtn, text: elActionText(applyBtn) || "Apply" };
      }
    }
    return null;
  };

  function describeAction(action) {
    if (!action) return null;
    return {
      type: action.type,
      text: action.text || elActionText(action.el),
      disabled: Boolean(action.disabled)
    };
  }

  async function clickKeepingSameTab(el, { preferNewTab = false } = {}) {
    if (!el) return { clicked: false, navigateUrl: "", openInNewTab: false };
    let capturedUrl = "";
    const origOpen = window.open;
    window.open = function (url) {
      capturedUrl = String(url || "");
      return null;
    };
    try {
      if (el.tagName === "A") {
        const href = String(el.href || "").trim();
        const target = String(el.getAttribute("target") || "").toLowerCase();
        if (/^https?:/i.test(href) && (preferNewTab || target === "_blank" || target === "blank")) {
          return { clicked: false, navigateUrl: href, openInNewTab: true };
        }
        if (!preferNewTab) el.setAttribute("target", "_self");
      }
      scrollElIntoView(el);
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
      const opts = { bubbles: true, cancelable: true, composed: true, view: window };
      try {
        el.dispatchEvent(
          new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse" })
        );
      } catch {
        /* ignore */
      }
      try {
        el.dispatchEvent(new MouseEvent("mousedown", opts));
      } catch {
        /* ignore */
      }
      try {
        el.dispatchEvent(
          new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse" })
        );
      } catch {
        /* ignore */
      }
      try {
        el.dispatchEvent(new MouseEvent("mouseup", opts));
      } catch {
        /* ignore */
      }
      try {
        el.dispatchEvent(new MouseEvent("click", opts));
      } catch {
        /* ignore */
      }
      el.click();
      await sleep(400);
      if (/^https?:/i.test(capturedUrl)) {
        return {
          clicked: false,
          navigateUrl: capturedUrl,
          openInNewTab: Boolean(preferNewTab)
        };
      }
      return { clicked: true, navigateUrl: "", openInNewTab: false };
    } finally {
      window.open = origOpen;
    }
  }

  async function clickEasyApplyEntry({ preferNewTab = false } = {}) {
    const target = findEasyApplyEntryButton();
    if (!target?.el) return { ok: false, clicked: false, navigateUrl: "", openInNewTab: false };
    const res = await clickKeepingSameTab(target.el, { preferNewTab });
    await sleep(res.clicked ? 800 : 200);
    return {
      ok: Boolean(res.clicked || res.navigateUrl),
      clicked: Boolean(res.clicked),
      navigateUrl: res.navigateUrl || "",
      openInNewTab: Boolean(res.openInNewTab || preferNewTab),
      text: target.text || elActionText(target.el)
    };
  }

  function stepSignature() {
    const scope = getApplyScope();
    const heading = cleanLabelText(
      scope.querySelector?.('h1, h2, h3, [role="heading"], legend')?.textContent || ""
    );
    const fields = scope.querySelectorAll?.("input, textarea, select").length || 0;
    return `${location.href}|${heading}|${fields}`;
  }

  function formNeedsFill() {
    if (detectApplicationSuccess()) return false;
    if (uploadsStillBusy()) return true;
    const fileInputs = collectFileInputs();
    for (const el of fileInputs) {
      const kind = classifyFileInput(el);
      if (kind !== "resume" && kind !== "coverLetter") continue;
      if (el.files && el.files.length) continue;
      const ctx = fileFieldContext(el).toLowerCase();
      // After Dice ingests a file it often clears the input but shows "Replace" / file name.
      if (/\b(uploaded|attached|selected|replace|remove)\b/.test(ctx)) continue;
      if (/\b(optional|not required|cover letter is not required)\b/.test(ctx)) continue;
      return true;
    }
    const controls = collectFillableControls();
    let empty = 0;
    for (const el of controls) {
      const type = String(el.type || "text").toLowerCase();
      if (["hidden", "file", "submit", "button", "image", "reset", "checkbox", "radio"].includes(type)) {
        continue;
      }
      if (el.tagName === "SELECT") {
        const opt = el.options?.[el.selectedIndex];
        const t = cleanLabelText(opt?.textContent || opt?.value || "");
        if (!t || /^(select\.\.\.?|please select|choose|--)$/i.test(t)) empty += 1;
        continue;
      }
      if (!String(el.value || "").trim()) empty += 1;
    }
    return empty >= 1;
  }

  function getApplyActionSnapshot() {
    const probe = probeApplicationForm();
    // Job listing / job-detail: only Easy Apply or Apply. Never ads, Cancel, Next job.
    if (!probe.isApplicationForm) {
      const alreadyApplied = probe.alreadyApplied || detectDiceAlreadyApplied();
      const entry = alreadyApplied ? null : findEasyApplyEntryButton();
      return {
        ok: true,
        href: location.href,
        signature: stepSignature(),
        isApplicationForm: false,
        blockedReason: probe.blockedReason || "",
        jobUnavailable: probe.jobUnavailable || "",
        alreadyApplied: alreadyApplied || "",
        applicationSuccess: detectApplicationSuccess(),
        action: entry ? { type: "entry", text: entry.text } : null,
        needsFill: false,
        uploadsBusy: false,
        applyUrls: probe.applyUrls || []
      };
    }
    let action = findActionButton(null, { includeDisabledSubmit: true });
    if (action?.type === "submit" && !probe.isApplicationForm) {
      const t = action.text || elActionText(action.el);
      if (EASY_ENTRY_RE.test(t)) {
        action = { type: "entry", el: action.el, text: t };
      }
    }
    const busy = uploadsStillBusy();
    // On the final Submit step, optional empty fields must not block Auto Apply.
    const needsFill =
      action?.type === "submit" ? busy : formNeedsFill() || busy;
    return {
      ok: true,
      href: location.href,
      signature: stepSignature(),
      isApplicationForm: Boolean(probe.isApplicationForm),
      blockedReason: probe.blockedReason || "",
      jobUnavailable: probe.jobUnavailable || "",
      alreadyApplied: "",
      applicationSuccess: detectApplicationSuccess(),
      action: describeAction(action),
      needsFill,
      uploadsBusy: busy,
      applyUrls: probe.applyUrls || []
    };
  }

  async function clickApplyAction(preferredType = "", { preferNewTab = false } = {}) {
    const before = getApplyActionSnapshot();
    let action = findActionButton();
    if (preferredType === "entry") {
      const entryRes = await clickEasyApplyEntry({ preferNewTab });
      await sleep(400);
      return {
        ok: Boolean(entryRes?.clicked || entryRes?.navigateUrl),
        clicked: Boolean(entryRes?.clicked),
        navigateUrl: entryRes?.navigateUrl || "",
        openInNewTab: Boolean(entryRes?.openInNewTab),
        isSubmit: false,
        action:
          entryRes?.clicked || entryRes?.navigateUrl
            ? { type: "entry", text: entryRes.text || "" }
            : null,
        before,
        after: getApplyActionSnapshot()
      };
    }

    // Never advance while files are still uploading — triggers "Leave site?" on Dice.
    if (
      (preferredType === "next" || preferredType === "review" || preferredType === "submit" || !preferredType) &&
      (before.uploadsBusy || uploadsStillBusy())
    ) {
      await waitForUploadsToSettle(15000);
      if (uploadsStillBusy()) {
        return {
          ok: false,
          clicked: false,
          navigateUrl: "",
          openInNewTab: false,
          isSubmit: false,
          deferred: "uploads-busy",
          action: null,
          before,
          after: getApplyActionSnapshot()
        };
      }
    }

    if (preferredType === "submit") {
      // Dice enables Submit a moment after the last step renders.
      for (let i = 0; i < 12; i += 1) {
        action = findActionButton(null, { includeDisabledSubmit: true });
        if (action?.type === "submit" && action.el && isElEnabled(action.el)) break;
        if (action?.type === "submit" && action.el && i >= 2) break;
        await sleep(250);
      }
      if (action?.type === "submit" && action.el && !isElEnabled(action.el)) {
        try {
          action.el.disabled = false;
          action.el.removeAttribute("disabled");
          action.el.setAttribute("aria-disabled", "false");
        } catch {
          /* ignore */
        }
      }
    } else if (preferredType) {
      const scopeEl = getApplyScope();
      const buttons = [
        ...scopeEl.querySelectorAll(
          'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
        )
      ].filter((el) => isElVisible(el) && isElEnabled(el) && !isSiteChromeControl(el));
      const scored = [];
      for (const btn of buttons) {
        const text = elActionText(btn);
        if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(btn)) continue;
        const cls = classifyActionButton(text);
        let match = false;
        if (preferredType === "entry") match = Boolean(findEasyApplyEntryButton()?.el === btn);
        else if (cls === preferredType) match = true;
        if (match) {
          scored.push({
            type: preferredType,
            el: btn,
            text: elActionText(btn),
            score: actionButtonScore(btn, preferredType)
          });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored[0] && scored[0].score > -100) {
        action = scored[0];
      }
    }
    // Remap listing-page Apply → entry (same as snapshot).
    if (action?.type === "submit" && !before.isApplicationForm) {
      const t = action.text || elActionText(action.el);
      if (EASY_ENTRY_RE.test(t)) {
        action = { type: "entry", el: action.el, text: t };
      }
    }
    if (!action) {
      return { ok: false, clicked: false, openInNewTab: false, before, after: before };
    }
    const clickRes = await clickKeepingSameTab(action.el, {
      preferNewTab: preferNewTab && action.type === "entry"
    });
    return {
      ok: Boolean(clickRes.clicked || clickRes.navigateUrl),
      clicked: Boolean(clickRes.clicked),
      navigateUrl: clickRes.navigateUrl || "",
      openInNewTab: Boolean(clickRes.openInNewTab),
      isSubmit: action.type === "submit",
      action: describeAction(action),
      before,
      after: getApplyActionSnapshot()
    };
  }

  async function waitForStepChange(prevSig, timeoutMs = 12000) {
    const start = Date.now();
    const prevHref = location.href;
    while (Date.now() - start < timeoutMs) {
      await sleep(350);
      if (location.href !== prevHref) {
        await sleep(500);
        return true;
      }
      if (stepSignature() !== prevSig) {
        await sleep(300);
        return true;
      }
    }
    return false;
  }

  async function requestAnswersFromSw(questions, profileId, jobMeta, site) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "easy_apply_answer_questions",
        questions,
        profileId,
        jobMeta,
        site
      });
      return Array.isArray(res?.answers) ? res.answers : [];
    } catch {
      return [];
    }
  }

  async function requestChoiceAnswersFromSw(questions, profileId, site = "") {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "easy_apply_choice_answers",
        questions,
        profileId,
        site
      });
      return Array.isArray(res?.answers) ? res.answers : [];
    } catch {
      return [];
    }
  }

  async function runEasyApply({
    applicantInfo = {},
    uploadFiles = {},
    credentials = {},
    profileId = "",
    jobMeta = {},
    site = "generic",
    autoSubmit = false,
    maxSteps = 12,
    workHistory = [],
    educationHistory = []
  } = {}) {
    const summary = {
      ok: true,
      site,
      steps: 0,
      filled: 0,
      uploaded: 0,
      aiFilled: 0,
      answered: 0,
      status: "",
      detail: ""
    };

    const goneAtStart = detectJobUnavailable();
    if (goneAtStart) {
      summary.status = "unavailable";
      summary.detail = goneAtStart;
      return summary;
    }
    if (detectPageBlocker()) {
      summary.status = "needs_review";
      summary.detail = detectPageBlocker();
      return summary;
    }

    // Open the apply modal if we're still on the job listing view.
    let probe = probeApplicationForm();
    if (!probe.isApplicationForm) {
      await clickEasyApplyEntry();
      probe = probeApplicationForm();
      if (detectPageBlocker()) {
        summary.status = "needs_review";
        summary.detail = detectPageBlocker();
        return summary;
      }
    }

    let noAdvance = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      const goneNow = detectJobUnavailable();
      if (goneNow) {
        summary.status = "unavailable";
        summary.detail = goneNow;
        return summary;
      }
      if (detectPageBlocker()) {
        summary.status = "needs_review";
        summary.detail = detectPageBlocker();
        return summary;
      }

      const fillRes = await autofillApplication(applicantInfo, uploadFiles, credentials, {
        workHistory,
        educationHistory
      });
      summary.filled += Number(fillRes.filledCount || 0);
      summary.uploaded += Number(fillRes.uploadedCount || 0);

      // Reuse stored answers for novel dropdown/checkbox/radio questions.
      const choiceQuestions = Array.isArray(fillRes.unmatchedChoiceQuestions)
        ? fillRes.unmatchedChoiceQuestions
        : [];
      if (choiceQuestions.length) {
        const choiceAnswers = await requestChoiceAnswersFromSw(choiceQuestions, profileId, site);
        if (choiceAnswers.length) {
          const r = await fillChoiceAnswers(choiceAnswers);
          summary.filled += Number(r.filledCount || 0);
        }
      }

      // Free-text questions are always answered fresh by AI (role/JD specific).
      const questions = Array.isArray(fillRes.unmatchedQuestions) ? fillRes.unmatchedQuestions : [];
      if (questions.length) {
        const answers = await requestAnswersFromSw(questions, profileId, jobMeta, site);
        if (answers.length) {
          const r = await fillAiAnswers(answers);
          summary.aiFilled += Number(r.filledCount || 0);
          summary.answered += answers.length;
        }
      }
      summary.steps = step + 1;

      if (uploadsStillBusy() || Number(fillRes.uploadedCount || 0) > 0) {
        await waitForUploadsToSettle(20000);
      }

      const action = findActionButton();
      if (!action) {
        const stillForm = probeApplicationForm().isApplicationForm;
        summary.status = stillForm ? "ready_for_review" : "needs_review";
        summary.detail = stillForm
          ? "Filled the form. No Next/Submit button detected — please review and submit."
          : "No application form or action button found on this page.";
        return summary;
      }

      if (action.type === "submit") {
        if (autoSubmit) {
          if (uploadsStillBusy()) await waitForUploadsToSettle(15000);
          scrollElIntoView(action.el);
          action.el.click();
          const start = Date.now();
          while (Date.now() - start < 20000) {
            await sleep(400);
            const success = detectApplicationSuccess();
            if (success) {
              summary.status = "submitted";
              summary.detail = success;
              return summary;
            }
          }
          summary.status = "needs_review";
          summary.detail =
            "Clicked Submit but the confirmation page did not appear. Review and confirm.";
          return summary;
        }
        summary.status = "ready_for_review";
        summary.detail = "Reached the final Submit step. Stopped so you can review and submit.";
        return summary;
      }

      if (uploadsStillBusy()) {
        summary.status = "needs_review";
        summary.detail =
          "File upload is still in progress. Wait for it to finish, then run Auto Apply again.";
        return summary;
      }

      const sigBefore = stepSignature();
      scrollElIntoView(action.el);
      action.el.click();
      const advanced = await waitForStepChange(sigBefore);
      if (advanced) {
        noAdvance = 0;
      } else {
        noAdvance += 1;
        if (noAdvance >= 2) {
          summary.status = "needs_review";
          summary.detail =
            "Could not advance past this step (a required field or validation likely needs your input).";
          return summary;
        }
      }
    }

    summary.status = "ready_for_review";
    summary.detail = "Reached the step limit; please review the remaining steps.";
    return summary;
  }

  // ---- Learn mode: passively grow the Q&A bank from real user answers -------

  // Skip identity / PII / secrets / protected-class fields — those are handled by
  // deterministic profile fields and must never be persisted to an exportable bank.
  const LEARN_SENSITIVE_RE =
    /\b(password|otp|captcha|ssn|social security|credit card|card number|cvv|routing|account number|search|first name|last name|full name|middle name|legal name|email|e-mail|phone|mobile|telephone|address|street|city|state|province|zip|postal|country|linkedin|github|portfolio|website|date of birth|dob|birthday|salary|compensation|desired pay|expected pay|disability|veteran|military|\brace\b|ethnic|gender|\bsex\b|hispanic|latino|felony|conviction|criminal)\b/i;

  function captureQuestionText(el) {
    const q = questionLabelForControl(el);
    if (q) return q;
    const fieldset = el.closest("fieldset");
    const legend = fieldset?.querySelector(":scope > legend");
    if (legend) {
      const t = cleanLabelText(legend.textContent);
      if (t) return t;
    }
    const group = el.closest('[role="radiogroup"], [role="group"]');
    const aria = group?.getAttribute?.("aria-label");
    if (aria) return cleanLabelText(aria);
    return questionTextForAi(el);
  }

  function readControlAnswer(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opt = el.options?.[el.selectedIndex];
      const t = cleanLabelText(opt?.textContent || opt?.value || "");
      return /^(select\.\.\.?|please select|choose|--)$/i.test(t) ? "" : t;
    }
    const type = (el.type || "text").toLowerCase();
    if (type === "checkbox") return el.checked ? "Yes" : "No";
    if (type === "radio") {
      if (!el.checked) return "";
      return cleanLabelText(questionTextForAi(el) || el.value);
    }
    return cleanLabelText(el.value || "");
  }

  /** Map a chosen option/answer back to the profile's canonical stored value. */
  function canonicalValueForKey(key, text) {
    const t = normalize(text);
    if (!t) return String(text || "").trim();
    const map = VALUE_LABELS[key];
    if (map) {
      for (const canon of Object.keys(map)) {
        if (normalize(canon) === t) return canon;
        for (const label of map[canon]) {
          if (normalize(label) === t) return canon;
        }
      }
    }
    if (YES_VALUES.has(t)) return "yes";
    if (NO_VALUES.has(t)) return "no";
    return String(text || "").trim();
  }

  function maybeCaptureLearn(el) {
    if (!learnEnabled) return;
    if (Date.now() < learnSuppressUntil) return;
    if (!el || typeof el.matches !== "function") return;
    if (!el.matches("input, textarea, select")) return;

    const type = (el.type || "text").toLowerCase();
    if (["hidden", "file", "submit", "button", "image", "reset", "password"].includes(type)) return;
    // Combobox search inputs hold transient text, not a final answer.
    if (isReactSelectInput(el) || looksLikeCombobox(el)) return;

    const answer = readControlAnswer(el);
    if (!answer || answer.length > 2000) return;

    // Known profile field (name, contact, links, work-eligibility, education,
    // EEO, salary, ...) → learn into the PROFILE with fill-if-empty semantics so
    // the deterministic autofill reuses it. These are the most common questions
    // and are kept out of the exportable Q&A bank.
    const profileKey = matchApplicantKeyFromControl(el);
    if (profileKey) {
      const value = canonicalValueForKey(profileKey, answer);
      if (!value) return;
      const sig = `k:${profileKey}`;
      if (learnSentByQuestion.get(sig) === value) return;
      learnSentByQuestion.set(sig, value);
      try {
        chrome.runtime.sendMessage({ type: "profile_learn_capture", key: profileKey, value });
      } catch {
        /* extension context invalidated — ignore */
      }
      return;
    }

    // Novel questions (dropdown / checkbox / radio / short text) go into the
    // per-profile Q&A bank. Long essays stay out — those are JD-specific.
    const isChoice = el.tagName === "SELECT" || type === "radio" || type === "checkbox";
    if (!isChoice) {
      if (el.tagName === "TEXTAREA" && answer.length > 160) return;
      if (answer.length > 400) return;
    }

    const label = captureQuestionText(el);
    if (!label) return;
    if (LEARN_SENSITIVE_RE.test(label)) return;

    const labelNorm = normalize(label);
    if (!labelNorm || labelNorm.length < 6) return;

    if (learnSentByQuestion.get(labelNorm) === answer) return;
    learnSentByQuestion.set(labelNorm, answer);

    const fieldType =
      el.tagName === "SELECT"
        ? "select"
        : el.tagName === "TEXTAREA"
          ? "textarea"
          : type === "checkbox"
            ? "checkbox"
            : type === "radio"
              ? "radio"
              : "text";

    try {
      chrome.runtime.sendMessage({
        type: "qa_learn_capture",
        question: label.slice(0, 1000),
        answer: answer.slice(0, 2000),
        fieldType,
        site: location.hostname
      });
    } catch {
      /* extension context invalidated — ignore */
    }
  }

  function onLearnEvent(event) {
    try {
      maybeCaptureLearn(event.target);
    } catch {
      /* never let capture break the page */
    }
  }

  function initLearnMode() {
    chrome.storage.local
      .get("qa_learn_enabled")
      .then((data) => {
        learnEnabled = data.qa_learn_enabled !== false;
      })
      .catch(() => {});

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.qa_learn_enabled) {
        learnEnabled = changes.qa_learn_enabled.newValue !== false;
      }
    });

    document.addEventListener("change", onLearnEvent, true);
    document.addEventListener("focusout", onLearnEvent, true);
  }

  initLearnMode();

  // ---- Job page scraping (site-specific, extensible) ------------------------
  //
  // Each site posts its job data in a slightly different shape. We keep a small
  // registry of site scrapers keyed by hostname, and always fall back to the
  // schema.org JobPosting JSON-LD block that most boards/ATS embed. To add a new
  // site, append an entry to JOB_SCRAPERS with a host matcher and a scrape().

  function htmlToPlainText(html) {
    let s = String(html || "");
    if (!s) return "";
    s = s
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "- ")
      .replace(/<\/\s*li\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|h[1-6]|ul|ol|section|article|tr|table)\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&rsquo;/gi, "\u2019");
    return s
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readJsonScript(id, root = document) {
    const el =
      typeof root.getElementById === "function"
        ? root.getElementById(id)
        : root.querySelector(`#${CSS.escape(id)}`);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || el.innerText || "");
    } catch {
      return null;
    }
  }

  function jobrightIdFromUrl() {
    const m = String(location.pathname || "").match(/\/jobs\/info\/([A-Za-z0-9]+)/);
    return m ? m[1] : "";
  }

  function canonicalPageUrl() {
    const link = document.querySelector('link[rel="canonical"]');
    const href = link?.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) return href;
    try {
      const u = new URL(location.href);
      u.hash = "";
      return u.toString();
    } catch {
      return location.href;
    }
  }

  function normalizeEmploymentType(value) {
    const v = String(Array.isArray(value) ? value[0] : value || "").trim();
    if (!v) return "";
    const map = {
      FULL_TIME: "Full-time",
      PART_TIME: "Part-time",
      CONTRACTOR: "Contract",
      CONTRACT: "Contract",
      TEMPORARY: "Temporary",
      INTERN: "Internship",
      INTERNSHIP: "Internship",
      VOLUNTEER: "Volunteer",
      PER_DIEM: "Per diem",
      OTHER: "Other"
    };
    return map[v.toUpperCase().replace(/[\s-]+/g, "_")] || v;
  }

  function sectionLines(title, arr) {
    const items = (Array.isArray(arr) ? arr : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    if (!items.length) return [];
    return [`${title}:`, ...items.map((it) => `- ${it}`), ""];
  }

  function buildJobrightJdText(jr = {}, cr = {}) {
    const lines = [];
    const summary = String(jr.jobSummary || "").trim();
    if (summary) lines.push(summary, "");
    lines.push(...sectionLines("Responsibilities", jr.coreResponsibilities));
    lines.push(...sectionLines("Qualifications / Skills", jr.skillSummaries));
    lines.push(...sectionLines("Education", jr.educationSummaries));
    lines.push(...sectionLines("Benefits", jr.benefitsSummaries));
    const companyDesc = String(cr.companyDesc || "").trim();
    if (companyDesc) lines.push("Company Overview:", companyDesc);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function companyFromJobrightChrome(doc = document) {
    const title = String(
      doc.querySelector?.("title")?.textContent || doc.title || ""
    ).trim();
    // e.g. "Sr Applications Developer (Salesforce) @ HealthEquity | Jobright.ai"
    let m = title.match(/\s@\s(.+?)\s*\|\s*Jobright/i);
    if (m?.[1]) return m[1].trim();

    const og = doc.querySelector?.('meta[property="og:title"], meta[name="title"]');
    const ogTitle = String(og?.getAttribute?.("content") || "").trim();
    m = ogTitle.match(/\s@\s(.+?)\s*\|\s*Jobright/i);
    if (m?.[1]) return m[1].trim();

    return "";
  }

  /**
   * Pull the job/company/posting payloads out of a document, keeping only the
   * ones that belong to `urlId`. Jobright is a Next.js SPA: `__NEXT_DATA__` is
   * baked in at the FIRST server render and is NOT updated on client-side
   * navigation, so it can describe a previously viewed job. Matching on the job
   * id in the URL is what prevents returning the wrong (stale) job.
   */
  function pickJobrightSources(doc, urlId) {
    const nextDs = readJsonScript("__NEXT_DATA__", doc)?.props?.pageProps?.dataSource || null;
    const helper = readJsonScript("jobright-helper-job-detail-info", doc);
    const posting = readJsonScript("job-posting", doc);

    const candidates = [];
    // Prefer sources that include companyResult (helper is the head-managed
    // payload that updates on SPA navigation; __NEXT_DATA__ can be stale).
    if (helper?.jobResult) {
      candidates.push([helper.jobResult, helper.companyResult || {}]);
    }
    if (nextDs?.jobResult) {
      candidates.push([nextDs.jobResult, nextDs.companyResult || {}]);
    }

    let jr = null;
    let cr = {};
    for (const [cjr, ccr] of candidates) {
      if (urlId && String(cjr.jobId || "") !== urlId) continue;
      if (!jr) jr = cjr;
      if (ccr?.companyName) {
        cr = ccr;
        break;
      }
      if (!cr?.companyName && ccr && Object.keys(ccr).length) cr = ccr;
    }

    // If we matched a job without company, steal companyResult from any
    // same-id candidate (e.g. helper job + nextData company, or vice versa).
    if (jr && !cr?.companyName) {
      for (const [cjr, ccr] of candidates) {
        if (String(cjr.jobId || "") === String(jr.jobId || "") && ccr?.companyName) {
          cr = ccr;
          break;
        }
      }
      if (!cr?.companyName && helper?.companyResult?.companyName) {
        const helperJobId = String(helper?.jobResult?.jobId || "");
        if (!urlId || !helperJobId || helperJobId === urlId) {
          cr = helper.companyResult;
        }
      }
    }

    let validPosting = null;
    if (posting) {
      const pid = String(posting?.identifier?.value || "");
      // Accept posting when id matches, or when id is absent (SPA-updated head
      // scripts sometimes omit identifier while still describing the open job).
      if (!urlId || !pid || pid === urlId) validPosting = posting;
    }

    return {
      jr,
      cr,
      posting: validPosting,
      pageCompany: companyFromJobrightChrome(doc)
    };
  }

  function assembleJobright({ jr, cr, posting, pageCompany }) {
    if (!jr && !posting) return null;
    jr = jr || {};
    cr = cr || {};

    const jobTitle = String(jr.jobTitle || jr.jobNlpTitle || posting?.title || "")
      .replace(/^\[Remote\]\s*/i, "")
      .trim();
    const socialCompany = Array.isArray(jr.socialConnections)
      ? String(
          jr.socialConnections.find((c) => c?.companyName)?.companyName || ""
        ).trim()
      : "";
    const companyName = String(
      cr.companyName ||
        jr.companyName ||
        socialCompany ||
        posting?.hiringOrganization?.name ||
        pageCompany ||
        ""
    ).trim();

    // Prefer the full schema.org JobPosting description (richest, includes
    // responsibilities/skills/benefits/company overview), then fall back to
    // rebuilding the JD from the structured jobResult fields.
    let jdText = htmlToPlainText(posting?.description || "");
    if (!jdText) jdText = buildJobrightJdText(jr, cr);

    const sal = posting?.baseSalary?.value || {};
    const remoteFromPosting =
      String(posting?.jobLocationType || "").toUpperCase() === "TELECOMMUTE" ? "Remote" : "";

    return {
      jobId: String(jr.jobId || posting?.identifier?.value || ""),
      jobTitle,
      companyName,
      jdLink: canonicalPageUrl(),
      jdText,
      applyLink: String(jr.applyLink || jr.originalUrl || posting?.url || "").trim(),
      workArrangement: String(
        jr.workModel || (jr.isRemote ? "Remote" : "") || remoteFromPosting
      ).trim(),
      employmentType: normalizeEmploymentType(jr.employmentType || posting?.employmentType),
      salaryMin:
        jr.minSalary != null && jr.minSalary !== ""
          ? String(jr.minSalary)
          : sal.minValue != null
            ? String(sal.minValue)
            : "",
      salaryMax:
        jr.maxSalary != null && jr.maxSalary !== ""
          ? String(jr.maxSalary)
          : sal.maxValue != null
            ? String(sal.maxValue)
            : "",
      datePosted: String(jr.publishTime || posting?.datePosted || "").trim(),
      jobLocation: String(jr.jobLocation || "").trim()
    };
  }

  async function scrapeJobright() {
    const urlId = jobrightIdFromUrl();

    // 1) Use the in-page data, but only if it belongs to the job in the URL.
    let data = assembleJobright(pickJobrightSources(document, urlId));
    // Prefer a complete scrape (company included). If company is missing, keep
    // going to the fresh HTML fetch — SPA pages often have job text but no
    // companyResult until the server render is re-fetched.
    if (
      data &&
      (!urlId || data.jobId === urlId) &&
      (data.jobTitle || data.jdText) &&
      data.companyName
    ) {
      return data;
    }

    // 2) The embedded payload was stale (SPA navigation) or missing company —
    //    re-fetch the current URL's server-rendered HTML and parse it.
    try {
      const res = await fetch(location.href, {
        credentials: "include",
        headers: { Accept: "text/html" },
        cache: "no-store"
      });
      if (res.ok) {
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const fetched = assembleJobright(pickJobrightSources(doc, urlId));
        if (fetched && (fetched.jobTitle || fetched.jdText)) {
          // Merge: prefer fetched company/title, keep any richer in-page JD.
          if (data) {
            return {
              ...data,
              ...fetched,
              companyName: fetched.companyName || data.companyName || "",
              jobTitle: fetched.jobTitle || data.jobTitle || "",
              jdText: fetched.jdText || data.jdText || ""
            };
          }
          return fetched;
        }
      }
    } catch {
      /* network/parse failure — fall back to whatever we had */
    }

    return data && (data.jobTitle || data.jdText) ? data : null;
  }

  function findJobPostingLdJson(root = document) {
    const scripts = root.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let data;
      try {
        data = JSON.parse(s.textContent || "");
      } catch {
        continue;
      }
      const nodes = Array.isArray(data)
        ? data
        : Array.isArray(data?.["@graph"])
          ? data["@graph"]
          : [data];
      for (const node of nodes) {
        const type = node?.["@type"];
        const isJob =
          type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        if (isJob) return node;
      }
    }
    return null;
  }

  function extractSchemaLocation(node) {
    const loc = Array.isArray(node?.jobLocation) ? node.jobLocation[0] : node?.jobLocation;
    const addr = loc?.address || {};
    return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(", ");
  }

  function scrapeSchemaOrgJobPosting() {
    const node = findJobPostingLdJson();
    if (!node) return null;

    const jobTitle = String(node.title || node.name || "").trim();
    const org = node.hiringOrganization;
    const companyName = String(
      (org && (org.name || org.legalName)) || (typeof org === "string" ? org : "") || ""
    ).trim();
    const jdText = htmlToPlainText(node.description || "");
    if (!jobTitle && !jdText) return null;

    const salaryValue = node.baseSalary?.value || node.estimatedSalary?.value || {};
    const remote =
      String(node.jobLocationType || "").toUpperCase() === "TELECOMMUTE" ? "Remote" : "";

    return {
      jobTitle,
      companyName,
      jdLink: canonicalPageUrl(),
      jdText,
      applyLink: String(node.url || "").trim(),
      workArrangement: remote,
      employmentType: normalizeEmploymentType(node.employmentType),
      salaryMin: salaryValue.minValue != null ? String(salaryValue.minValue) : "",
      salaryMax: salaryValue.maxValue != null ? String(salaryValue.maxValue) : "",
      datePosted: String(node.datePosted || "").trim(),
      jobLocation: extractSchemaLocation(node)
    };
  }

  function diceIdFromUrl(url = location.href) {
    try {
      const u = new URL(String(url || ""), "https://www.dice.com");
      const selected = u.searchParams.get("selectedJobId");
      if (selected) return selected;
      const parts = u.pathname.split("/").filter(Boolean);
      const detailIdx = parts.findIndex((p) => p === "job-detail" || p === "detail");
      if (detailIdx >= 0 && parts[detailIdx + 1]) {
        // Modern Dice: /job-detail/{uuid}
        // Legacy: /job-detail/{slug}/{id} or /jobs/detail/{id}
        if (parts[detailIdx] === "job-detail" && parts[detailIdx + 2]) {
          return parts[detailIdx + 2];
        }
        return parts[detailIdx + 1];
      }
      return u.searchParams.get("jobId") || u.searchParams.get("id") || "";
    } catch {
      return "";
    }
  }

  function elementText(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function locationFromLd(ld) {
    if (!ld) return "";
    if (ld.applicantLocationRequirements?.name) {
      return String(ld.applicantLocationRequirements.name).trim();
    }
    const loc = ld.jobLocation;
    if (typeof loc === "string") return loc.trim();
    const first = Array.isArray(loc) ? loc[0] : loc;
    if (!first) return "";
    if (typeof first === "string") return first.trim();
    const addr = first.address || {};
    return (
      [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .join(", ") ||
      String(first.name || "").trim()
    );
  }

  function salaryBoundsFromLd(ld) {
    const raw = ld?.baseSalary?.value ?? ld?.estimatedSalary?.value;
    if (raw == null || raw === "") return { min: "", max: "" };
    if (typeof raw === "number" || typeof raw === "string") {
      const n = String(raw).trim();
      return { min: n, max: n };
    }
    return {
      min: raw.minValue != null ? String(raw.minValue) : "",
      max: raw.maxValue != null ? String(raw.maxValue) : ""
    };
  }

  function diceDetailRoot(doc = document) {
    return (
      doc.querySelector('[class*="@container/job-detail"]') ||
      doc.querySelector('[class*="job-detail"]') ||
      doc.querySelector("main") ||
      doc.body ||
      doc
    );
  }

  function diceCompanyFromDom(root) {
    const links = Array.from(root.querySelectorAll('a[href*="/company-profile/"]'));
    for (const a of links) {
      const t = elementText(a);
      if (t) return t;
    }
    return (
      elementText(root.querySelector('[data-cy="companyNameLink"]')) ||
      elementText(root.querySelector('[data-cy="companyName"]')) ||
      elementText(root.querySelector("[class*='companyName']")) ||
      ""
    );
  }

  function diceIdFromDom(doc = document) {
    const fromUrl = diceIdFromUrl(doc.defaultView?.location?.href || location.href);
    if (fromUrl) return fromUrl;
    const root = diceDetailRoot(doc);
    const href =
      root.querySelector('a[href*="/job-detail/"]')?.getAttribute("href") ||
      doc.querySelector('a[href*="/job-detail/"]')?.getAttribute("href") ||
      "";
    return diceIdFromUrl(href) || "";
  }

  function diceCanonicalLink(jobId) {
    if (jobId) return `https://www.dice.com/job-detail/${jobId}`;
    try {
      if (/\/job-detail\//i.test(location.pathname)) {
        const u = new URL(location.href);
        u.hash = "";
        u.search = "";
        return u.toString();
      }
    } catch {
      /* ignore */
    }
    return canonicalPageUrl();
  }

  function assembleDiceFromLd(ld, { jobId = "", dom = null } = {}) {
    if (!ld && !dom) return null;
    ld = ld || {};
    dom = dom || {};

    const ldOrg = ld.hiringOrganization;
    const ldCompany =
      (ldOrg && (ldOrg.name || ldOrg.legalName)) ||
      (typeof ldOrg === "string" ? ldOrg : "") ||
      "";
    const salary = salaryBoundsFromLd(ld);
    const remoteFromLd =
      String(ld.jobLocationType || "").toUpperCase() === "TELECOMMUTE" ? "Remote" : "";

    let jdText = String(dom.jdText || "").trim();
    if (!jdText && ld.description) jdText = htmlToPlainText(ld.description);

    const skills = Array.isArray(dom.skills) ? dom.skills.filter(Boolean) : [];
    if (skills.length && jdText && !/^Key skills:/i.test(jdText)) {
      jdText = `Key skills:\n${skills.join("; ")}\n\n${jdText}`;
    } else if (skills.length && !jdText) {
      jdText = `Key skills:\n${skills.join("; ")}`;
    }

    const id =
      jobId ||
      String(ld.identifier?.value || "") ||
      diceIdFromUrl(String(ld.url || "")) ||
      "";
    const jobTitle =
      String(dom.jobTitle || "").trim() || String(ld.title || ld.name || "").trim();
    const companyName = String(dom.companyName || "").trim() || String(ldCompany).trim();

    if (!jobTitle && !jdText) return null;

    return {
      jobId: id,
      jobTitle,
      companyName,
      jdLink: diceCanonicalLink(id),
      jdText,
      applyLink: String(ld.url || "").trim(),
      workArrangement: String(dom.workArrangement || "").trim() || remoteFromLd,
      employmentType: normalizeEmploymentType(
        dom.employmentType || ld.employmentType
      ),
      salaryMin: salary.min,
      salaryMax: salary.max,
      datePosted:
        String(dom.datePosted || "").trim() || String(ld.datePosted || "").trim(),
      jobLocation: String(dom.jobLocation || "").trim() || locationFromLd(ld)
    };
  }

  /**
   * Dice scrape for the current redesigned UI:
   * - Dedicated /job-detail/{uuid} pages embed schema.org JobPosting JSON-LD.
   * - Search SERP uses a side panel (`?selectedJobId=`) with NO JSON-LD and no
   *   legacy data-cy hooks; JD lives in a CSS-module class containing
   *   "jobDescription". When the panel is incomplete we fetch the detail URL.
   */
  function scrapeDiceDom(doc = document) {
    const root = diceDetailRoot(doc);
    const text = elementText;

    const titleEl =
      root.querySelector('[data-cy="jobTitle"]') ||
      root.querySelector("h1") ||
      root.querySelector('[class*="jobTitle"]') ||
      doc.querySelector("h1");

    const locationEl =
      root.querySelector('[data-cy="location"]') ||
      root.querySelector('[data-cy="jobLocation"]');

    // Modern Dice: job-detail-description-module__…__jobDescription
    // Legacy: #jobDescription / data-cy / job-description
    const descEl =
      root.querySelector('[class*="jobDescription"]') ||
      root.querySelector('[class*="job-detail-description"]') ||
      root.querySelector("#jobDescription") ||
      root.querySelector('[data-cy="jobDescription"]') ||
      root.querySelector('[class*="job-description"]') ||
      root.querySelector('[id*="description"]');

    let jdText = "";
    if (descEl) {
      jdText = String(descEl.innerText || descEl.textContent || "")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const skills = Array.from(
      root.querySelectorAll(
        '[data-cy="skillsList"] li, [data-cy="chip"], [class*="skill"] li, [class*="SkillChip"], [class*="SkillBadge"]'
      )
    )
      .map((el) => text(el))
      .filter(Boolean)
      .slice(0, 40);

    // Header line often looks like "Remote or Olympia, Washington•Today"
    let workArrangement = "";
    let datePosted = "";
    const headerBits = Array.from(
      root.querySelectorAll("span, div, p, li, time")
    )
      .map((el) => text(el))
      .filter((t) => t && t.length < 80);
    for (const t of headerBits) {
      if (!workArrangement && /\b(Remote|Hybrid|On-?site)\b/i.test(t)) {
        if (/remote/i.test(t)) workArrangement = "Remote";
        else if (/hybrid/i.test(t)) workArrangement = "Hybrid";
        else workArrangement = "On-site";
      }
      if (!datePosted && /^(today|yesterday|\d+\s*(day|hour|week|month)s?\s*ago)$/i.test(t)) {
        datePosted = t;
      }
    }
    datePosted =
      datePosted ||
      text(root.querySelector('[data-cy="postedDate"]')) ||
      text(root.querySelector("time")) ||
      "";

    return {
      jobTitle: text(titleEl),
      companyName: diceCompanyFromDom(root),
      jobLocation: text(locationEl),
      jdText,
      workArrangement:
        workArrangement ||
        text(root.querySelector('[data-cy="workplaceType"]')) ||
        text(root.querySelector('[data-cy="workSettings"]')) ||
        "",
      employmentType:
        text(root.querySelector('[data-cy="employmentDetails"]')) ||
        text(root.querySelector('[data-cy="employmentType"]')) ||
        "",
      datePosted,
      skills
    };
  }

  function scrapeDiceOnce(doc = document) {
    const jobId = diceIdFromDom(doc);
    const dom = scrapeDiceDom(doc);
    const ld = findJobPostingLdJson(doc);
    return assembleDiceFromLd(ld, { jobId, dom });
  }

  async function fetchDiceDetailDocument(jobId) {
    if (!jobId) return null;
    try {
      const res = await fetch(`https://www.dice.com/job-detail/${jobId}`, {
        credentials: "include",
        headers: { Accept: "text/html" },
        cache: "no-store"
      });
      if (!res.ok) return null;
      const html = await res.text();
      return new DOMParser().parseFromString(html, "text/html");
    } catch {
      return null;
    }
  }

  function mergeDiceScrapes(base, next) {
    if (!base) return next;
    if (!next) return base;
    return {
      ...base,
      ...next,
      companyName: next.companyName || base.companyName || "",
      jobTitle: next.jobTitle || base.jobTitle || "",
      jdText: next.jdText || base.jdText || "",
      workArrangement: next.workArrangement || base.workArrangement || "",
      employmentType: next.employmentType || base.employmentType || "",
      salaryMin: next.salaryMin || base.salaryMin || "",
      salaryMax: next.salaryMax || base.salaryMax || "",
      datePosted: next.datePosted || base.datePosted || "",
      jobLocation: next.jobLocation || base.jobLocation || "",
      jobId: next.jobId || base.jobId || "",
      jdLink: next.jdLink || base.jdLink || ""
    };
  }

  async function scrapeDice() {
    let data = scrapeDiceOnce(document);
    if (data?.jobTitle && data?.companyName && data?.jdText) return data;

    // SERP side panel often has title/company in the DOM but no JSON-LD / incomplete
    // JD. Fetch the canonical /job-detail/{id} HTML (has JobPosting JSON-LD).
    const jobId = data?.jobId || diceIdFromDom(document);
    if (jobId) {
      const detailDoc = await fetchDiceDetailDocument(jobId);
      if (detailDoc) {
        const fetched = scrapeDiceOnce(detailDoc);
        data = mergeDiceScrapes(data, fetched);
        if (data?.jobTitle && data?.companyName && data?.jdText) return data;
      }
    }

    // Brief retries for client-side hydration on the open tab.
    for (const waitMs of [400, 800]) {
      await new Promise((r) => setTimeout(r, waitMs));
      data = mergeDiceScrapes(data, scrapeDiceOnce(document));
      if (data?.jobTitle && data?.companyName && data?.jdText) return data;
    }

    return data && (data.jobTitle || data.jdText) ? data : null;
  }

  // Registry of site-specific scrapers. Extend this as new sites are supported.
  const JOB_SCRAPERS = [
    { id: "jobright", host: /(^|\.)jobright\.ai$/i, scrape: scrapeJobright },
    { id: "dice", host: /(^|\.)dice\.com$/i, scrape: scrapeDice }
  ];

  async function scrapeJobPage() {
    const host = location.hostname || "";

    for (const scraper of JOB_SCRAPERS) {
      if (!scraper.host.test(host)) continue;
      try {
        const data = await scraper.scrape();
        if (data && (data.jobTitle || data.jdText)) {
          return { ok: true, site: scraper.id, jobData: data };
        }
      } catch {
        /* fall through to the generic schema.org scraper */
      }
    }

    // Generic fallback: most job boards / ATS embed a schema.org JobPosting.
    try {
      const data = scrapeSchemaOrgJobPosting();
      if (data && (data.jobTitle || data.jdText)) {
        return { ok: true, site: "schema.org", jobData: data };
      }
    } catch {
      /* ignore and report not-found below */
    }

    return {
      ok: false,
      error:
        "Could not detect job details on this page yet. Wait for it to finish loading, or paste the JD manually."
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "autofill_ping") {
      sendResponse({ ok: true, build: SCRIPT_BUILD });
      return false;
    }
    if (message?.type === "scrape_job_page") {
      scrapeJobPage()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "probe_application_form") {
      try {
        sendResponse(probeApplicationForm());
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
    if (message?.type === "autofill_ai_answers") {
      fillAiAnswers(message.answers || [])
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "autofill_choice_answers") {
      fillChoiceAnswers(message.answers || [])
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "autofill_credentials") {
      try {
        sendResponse({ ok: true, ...fillLoginCredentials(message.credentials || {}) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
    if (message?.type === "get_apply_action") {
      try {
        sendResponse(getApplyActionSnapshot());
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
    if (message?.type === "click_apply_action") {
      clickApplyAction(message.preferredType || "", {
        preferNewTab: Boolean(message.preferNewTab)
      })
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "click_easy_apply_entry") {
      clickEasyApplyEntry({ preferNewTab: Boolean(message.preferNewTab) })
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "wait_apply_step_change") {
      waitForStepChange(message.prevSignature || "", Number(message.timeoutMs) || 12000)
        .then((advanced) => sendResponse({ ok: true, advanced }))
        .catch((err) => sendResponse({ ok: false, advanced: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "easy_apply_run") {
      runEasyApply({
        applicantInfo: message.applicantInfo || {},
        uploadFiles: message.uploadFiles || {},
        credentials: message.credentials || {},
        profileId: message.profileId || "",
        jobMeta: message.jobMeta || {},
        site: message.site || "generic",
        autoSubmit: Boolean(message.autoSubmit),
        workHistory: message.workHistory || [],
        educationHistory: message.educationHistory || []
      })
        .then((summary) => sendResponse(summary))
        .catch((err) => sendResponse({ ok: false, status: "failed", error: String(err?.message || err) }));
      return true;
    }
    if (message?.type !== "autofill_application") return undefined;
    autofillApplication(
      message.applicantInfo || {},
      message.uploadFiles || {},
      message.credentials || {},
      {
        workHistory: message.workHistory || [],
        educationHistory: message.educationHistory || []
      }
    )
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
