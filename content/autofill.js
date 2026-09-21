/**
 * Generic application-form autofill (content script).
 * Fills text, textarea, select, checkbox, and radio controls from applicant info.
 * For dropdowns/comboboxes: never types "yes"/"no" — opens the list and picks a matching option.
 */
(function resumeBotAutofill() {
  // Keyed by build, not a plain boolean: a tab that already ran an older copy of
  // this script would otherwise block the updated one from installing.
  const SCRIPT_BUILD = "2026-09-20.jobright-linkedin-stop.1";
  const FIELD_FILL_DELAY_MS = 500;
  if (window.__resumeBotAutofillBuild === SCRIPT_BUILD) return;
  if (window.__resumeBotAutofillMessageListener) {
    try {
      chrome.runtime.onMessage.removeListener(window.__resumeBotAutofillMessageListener);
    } catch {
      /* ignore */
    }
  }
  window.__resumeBotAutofillBuild = SCRIPT_BUILD;
  window.__resumeBotAutofillInstalled = true;

  /** Query light DOM plus open shadow roots (Workday / some Greenhouse widgets). */
  function queryAllDeep(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node) return;
      try {
        if (node.querySelectorAll) out.push(...node.querySelectorAll(selector));
      } catch {
        /* invalid selector in this root */
      }
      const tree = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const el of tree) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function safeClick(el) {
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch {
      return false;
    }
  }

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
    // Bare "phone" / "mobile" matter: forms that pair a Country dropdown with a
    // plain "Phone" text box matched nothing and were left empty.
    phone: [
      "phone",
      "phone number",
      "mobile",
      "mobile number",
      "mobile phone",
      "cell",
      "cell phone",
      "telephone",
      "telephone number",
      "primary phone",
      "contact number"
    ],
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
    // Country pickers spell the US half a dozen ways, and the one sitting beside
    // a phone box often carries the dial code too.
    if (key === "country" && /united states|usa|^us$|^u\.s\.?a?\.?$/i.test(raw)) {
      for (const label of [
        "United States",
        "United States of America",
        "USA",
        "US",
        "United States (+1)",
        "United States of America (+1)"
      ]) {
        if (!out.includes(label)) out.push(label);
      }
    }
    if (/^(yes|no)$/i.test(raw)) {
      const titled = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      if (!out.includes(titled)) out.push(titled);
    }
    return out;
  }

  function setNativeValue(el, value, { emitChange = true } = {}) {
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
    if (emitChange) el.dispatchEvent(new Event("change", { bubbles: true }));
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
    // Placeholder / name hints are fallbacks only — high scores were stealing
    // real question labels and breaking Q&A bank matching.
    add(el.getAttribute("placeholder") || "", 480);
    add(el.getAttribute("aria-placeholder") || "", 470);
    add(identityHintFromControl(el), 200);

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
    const identityHint = identityHintFromControl(el);
    const placeholder = String(el.getAttribute("placeholder") || "").trim();
    // Prefer real labels for bank/profile matching; name/id hints only fill gaps.
    const primary = normalize(question || placeholder || identityHint);
    const full = normalize(
      [question, labelTextForControl(el), !question ? identityHint : ""].filter(Boolean).join(" ")
    );

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
    const placeholder = cleanLabelText(el.getAttribute("placeholder") || el.getAttribute("aria-placeholder"));
    if (placeholder && !/^(type here|enter text|write here|your answer|select)\.?$/i.test(placeholder)) {
      candidates.push(placeholder);
    }
    const identityHint = cleanLabelText(identityHintFromControl(el));
    if (identityHint) candidates.push(identityHint);

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

  /** "yes" / "no" when a label opens with one, else "" — negation must not be lost. */
  function leadingYesNo(text) {
    const t = normalize(text);
    if (/^y(es)?\b/.test(t)) return "yes";
    if (/^n(o)?\b/.test(t)) return "no";
    return "";
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

    // "Yes, I have a disability" and "No, I do not have a disability" share almost
    // every word, so token overlap used to treat them as the same option. When both
    // sides open with Yes/No, that prefix decides and nothing below may override it.
    const optLead = leadingYesNo(opt);
    const wantLead = leadingYesNo(want);
    if (optLead && wantLead && optLead !== wantLead) return false;

    // A one-word value has to land on a whole word: plain substring matching
    // selects "White / Caucasian" for "Asian", and "database" for a "BA" degree.
    if (!want.includes(" ")) {
      const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^| )${escaped}( |$)`).test(opt);
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

  async function pauseBetweenFields() {
    await sleep(FIELD_FILL_DELAY_MS);
  }

  /** Turn name/id tokens like candidate_profile.company-name.1 into "company name". */
  function identityHintFromControl(el) {
    const raw = [
      el.getAttribute?.("name") || "",
      el.getAttribute?.("id") || "",
      el.getAttribute?.("data-automation-id") || ""
    ]
      .filter(Boolean)
      .join(" ");
    if (!raw) return "";
    return normalize(
      raw
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[._\[\]/\\-]+/g, " ")
        .replace(/\b\d+\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
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
      el.closest(".select2") ||
      el.closest("[class*='select2-container']") ||
      el.closest("[class*='select-shell']") ||
      null
    );
  }

  function isReactSelectInput(el) {
    if (!el) return false;
    if (el.classList?.contains("select__input")) return true;
    if (el.classList?.contains("select2-search__field")) return true;
    if (/^react-select-\d+-input$/i.test(el.id || "")) return true;
    if (el.closest?.(".select__input-container, [class*='select__input'], .select2-search")) return true;
    return Boolean(getReactSelectRoot(el));
  }

  function controlPlaceholderText(el) {
    if (!el) return "";
    return String(
      el.getAttribute?.("placeholder") ||
        el.getAttribute?.("aria-placeholder") ||
        el.getAttribute?.("data-placeholder") ||
        ""
    ).trim();
  }

  function isSelectPlaceholderText(text) {
    return /^select(\s*\.{0,3})?$/i.test(String(text || "").trim());
  }

  /** Greenhouse custom questions: a fake dropdown with placeholder "Select...". */
  function isSelectPlaceholderWidget(el) {
    if (!el) return false;
    if (isSelectPlaceholderText(controlPlaceholderText(el))) return true;
    const root =
      getReactSelectRoot(el) ||
      el.closest?.("[class*='select'], [data-testid*='select'], label, .field") ||
      el.parentElement;
    if (!root) return false;
    const ph = root.querySelector?.(
      ".select__placeholder, [class*='select__placeholder'], .select2-selection__placeholder"
    );
    return isSelectPlaceholderText(cleanLabelText(ph?.textContent || ""));
  }

  function looksLikeAsyncAutocomplete(el) {
    if (!el || el.tagName !== "INPUT") return false;
    if (looksLikeCombobox(el) || isReactSelectInput(el) || isSelectPlaceholderWidget(el)) return false;
    const type = (el.type || "text").toLowerCase();
    if (!["text", "search", ""].includes(type)) return false;
    if (el.getAttribute("list")) return true;
    if (el.getAttribute("aria-autocomplete") === "list") return true;
    if ((el.getAttribute("role") || "").toLowerCase() === "combobox") return true;
    const cls = String(el.className || "");
    return /\b(typeahead|awesomplete|ui-autocomplete-input|pac-target-input)\b/i.test(cls);
  }

  function looksLikeCombobox(el) {
    if (!el) return false;
    if (isRichTextEditor(el)) return false;
    if (isReactSelectInput(el) || isSelectPlaceholderWidget(el)) return true;
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
        '[role="combobox"], .select__control, [class*="select__control"], .select2, [class*="select2"]'
      )
    );
  }

  function activeSelectMenu(root = document) {
    const menus = queryAllDeep(
      [
        '[role="listbox"]',
        ".select__menu",
        "[class*='select__menu']",
        ".select2-results",
        ".select2-dropdown",
        "[class*='Select-menu']",
        "[id*='react-select'][id*='-listbox']",
        ".ui-autocomplete",
        ".pac-container",
        "[class*='autocomplete'][class*='menu']",
        "[class*='typeahead']",
        "[class*='dropdown-menu']",
        "[class*='Suggestions']"
      ].join(", "),
      root
    );
    const visible = [];
    for (const menu of menus) {
      const style = window.getComputedStyle(menu);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = menu.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      visible.push(menu);
    }
    return visible[visible.length - 1] || null;
  }

  function collectVisibleOptions(root = document) {
    const menu = activeSelectMenu(root) || root;
    const selectors = [
      ".select__option",
      "[class*='select__option']",
      '[id*="react-select-"][id*="-option-"]',
      ".select2-results__option",
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
        nodes.push(...menu.querySelectorAll(sel));
      } catch {
        /* ignore */
      }
    }
    if (!nodes.length && menu !== root) {
      nodes.push(...menu.querySelectorAll("li, [data-value], button, div"));
    }
    const seen = new Set();
    const out = [];
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.getAttribute("aria-disabled") === "true") continue;
      if (node.classList?.contains("select__option--is-disabled")) continue;
      const text = cleanLabelText(node.textContent);
      if (!text || text.length > 180) continue;
      if (isSelectPlaceholderText(text)) continue;
      if (/^no (options|results|matches)/i.test(text)) continue;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (
        menu !== root &&
        node.querySelector?.('[role="option"], .select__option, .select2-results__option')
      ) {
        continue;
      }
      out.push(node);
    }
    return out;
  }

  function firstHighlightedOption(menu) {
    if (!menu) return null;
    return (
      menu.querySelector(
        [
          ".select__option--is-focused",
          "[class*='option--is-focused']",
          "[aria-selected='true']",
          ".select2-results__option--highlighted",
          "[class*='highlighted']",
          "[class*='--is-selected']"
        ].join(", ")
      ) || null
    );
  }

  function clickOptionNode(node) {
    if (!node) return false;
    const clickable =
      node.closest?.(
        "[role='option'], .select__option, [class*='select__option'], .select2-results__option, li, button, a, div"
      ) || node;
    try {
      clickable.scrollIntoView?.({ block: "nearest" });
    } catch {
      /* ignore */
    }
    // React-Select / many ATS widgets listen to mousedown more than click.
    for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
      try {
        clickable.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 })
        );
      } catch {
        /* ignore */
      }
    }
    try {
      clickable.click?.();
    } catch {
      /* ignore */
    }
    return true;
  }

  function isDropdownMenuOpen(el = null) {
    if (activeSelectMenu(document)) return true;
    const node = el || document.activeElement;
    if (!node) return false;
    if (String(node.getAttribute?.("aria-expanded") || "").toLowerCase() === "true") return true;
    const combo = node.closest?.('[role="combobox"], [aria-haspopup="listbox"], .select__control, [class*="select__control"]');
    if (combo && String(combo.getAttribute?.("aria-expanded") || "").toLowerCase() === "true") {
      return true;
    }
    return false;
  }

  /** Options near the focused combobox — catches custom popovers collectVisibleOptions misses. */
  function collectOptionsNearInput(input) {
    const near = collectVisibleOptions(document);
    if (near.length) return near;
    if (!input?.getBoundingClientRect) return [];
    const ir = input.getBoundingClientRect();
    const candidates = queryAllDeep(
      '[role="option"], [role="menuitem"], .select__option, [class*="select__option"], .select2-results__option, li[data-value], li'
    );
    const out = [];
    const seen = new Set();
    for (const node of candidates) {
      if (seen.has(node)) continue;
      seen.add(node);
      const text = cleanLabelText(node.textContent);
      if (!text || text.length > 180) continue;
      if (isSelectPlaceholderText(text)) continue;
      if (/^no (options|results|matches)/i.test(text)) continue;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      // Prefer items below/near the input (typical dropdown).
      if (r.top < ir.top - 40) continue;
      if (r.top > ir.bottom + 420) continue;
      if (r.left > ir.right + 80 || r.right < ir.left - 80) continue;
      out.push(node);
      if (out.length >= 40) break;
    }
    return out;
  }

  function openReactSelect(el) {
    const control =
      getReactSelectRoot(el) ||
      el.closest?.("[class*='select__control']") ||
      el.closest?.('[role="combobox"]') ||
      el;
    const indicator =
      control.querySelector?.(
        ".select__dropdown-indicator, [class*='select__dropdown-indicator'], .select2-selection__arrow, button[aria-label*='flyout'], button[aria-label*='Toggle']"
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
      control.querySelector?.(
        "input.select__input, input.select2-search__field, input[role='combobox'], input[aria-autocomplete], input"
      ) ||
      el;
    try {
      input.focus?.();
    } catch {
      /* ignore */
    }
    return input;
  }

  function pressKey(el, key, code = key) {
    if (!el) return;
    const keyCode =
      key === "Enter"
        ? 13
        : key === "ArrowDown"
          ? 40
          : key === "ArrowUp"
            ? 38
            : key === "Escape"
              ? 27
              : key === "Tab"
                ? 9
                : 0;
    const targets = [el];
    try {
      if (document.activeElement && document.activeElement !== el) {
        targets.push(document.activeElement);
      }
    } catch {
      /* ignore */
    }
    for (const target of targets) {
      const opts = {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      };
      try {
        target.focus?.({ preventScroll: true });
      } catch {
        try {
          target.focus?.();
        } catch {
          /* ignore */
        }
      }
      try {
        target.dispatchEvent(new KeyboardEvent("keydown", opts));
        if (key === "Enter" || key.length === 1) {
          target.dispatchEvent(new KeyboardEvent("keypress", opts));
        }
        target.dispatchEvent(new KeyboardEvent("keyup", opts));
      } catch {
        /* ignore */
      }
    }
  }

  async function typeIntoSelectFilter(input, text) {
    if (!input || input.tagName !== "INPUT") return;
    try {
      input.focus({ preventScroll: true });
    } catch {
      try {
        input.focus();
      } catch {
        /* ignore */
      }
    }
    setNativeValue(input, "", { emitChange: false });
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" })
    );
    const s = String(text || "");
    let current = "";
    for (const ch of s) {
      current += ch;
      try {
        input.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            composed: true,
            cancelable: true,
            data: ch,
            inputType: "insertText"
          })
        );
      } catch {
        /* ignore */
      }
      setNativeValue(input, current, { emitChange: false });
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: ch,
          inputType: "insertText"
        })
      );
      pressKey(input, ch, ch);
      await sleep(25);
    }
  }

  /**
   * True for widgets that accept several values at once (React-Select multi,
   * `<select multiple>`, aria-multiselectable listboxes).
   *
   * These keep their menu open after a pick, so the retry loops below used to
   * read "not committed yet" and click again — which is how one question ended
   * up holding "Yes, I have a disability", "No, I do not have a disability" and
   * "I don't wish to answer" at the same time.
   */
  function isMultiSelectWidget(el) {
    if (!el) return false;
    if (el.tagName === "SELECT") return Boolean(el.multiple);
    const root =
      getReactSelectRoot(el) ||
      el.closest?.("[class*='select__control'], [role='combobox'], [aria-haspopup='listbox']") ||
      el.parentElement;
    if (root?.querySelector?.("[class*='multi-value'], [class*='multiValue']")) return true;
    const combo = el.closest?.('[role="combobox"], [aria-haspopup="listbox"]') || el;
    if (String(combo?.getAttribute?.("aria-multiselectable") || "").toLowerCase() === "true") {
      return true;
    }
    const listId = combo?.getAttribute?.("aria-controls") || "";
    if (listId) {
      const list = document.getElementById(listId);
      if (String(list?.getAttribute?.("aria-multiselectable") || "").toLowerCase() === "true") {
        return true;
      }
    }
    return false;
  }

  /** Text of the chips a multi-select is already holding. */
  function selectedChipTexts(el) {
    if (!el) return [];
    if (el.tagName === "SELECT" && el.multiple) {
      return [...el.selectedOptions].map((o) => cleanLabelText(o.textContent || o.value)).filter(Boolean);
    }
    const root =
      getReactSelectRoot(el) ||
      el.closest?.("[class*='select__control'], [role='combobox'], [aria-haspopup='listbox']") ||
      el.parentElement;
    // Prefer the label node: the chip wrapper also contains the "remove" button,
    // so its textContent carries a stray × alongside the option text.
    const chips =
      root?.querySelectorAll?.("[class*='multi-value__label'], [class*='multiValue__label']") ||
      [];
    const wrappers = chips.length
      ? chips
      : root?.querySelectorAll?.("[class*='multi-value'], [class*='multiValue']") || [];
    const out = [];
    const seen = new Set();
    for (const chip of wrappers) {
      const text = cleanLabelText(chip.textContent).replace(/\s*[×✕✖x]\s*$/i, "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  function selectWidgetDisplayValue(el) {
    const root =
      getReactSelectRoot(el) ||
      el.closest?.("[class*='select'], .select2, label, .field") ||
      el.parentElement;
    const shown = cleanLabelText(
      root?.querySelector?.(
        ".select__single-value, [class*='select__single-value'], .select2-selection__rendered, [class*='singleValue']"
      )?.textContent || ""
    );
    if (shown && !isSelectPlaceholderText(shown)) return shown;
    return String(el.value || "").trim();
  }

  function selectLooksCommitted(el, candidates) {
    const chips = selectedChipTexts(el);
    if (chips.length) return chips.some((chip) => optionMatchesAny(chip, candidates));
    const shown = selectWidgetDisplayValue(el);
    if (!shown || isSelectPlaceholderText(shown)) return false;
    return optionMatchesAny(shown, candidates);
  }

  /**
   * True only when a dropdown choice is finalized — not when the user/filter
   * text is still sitting in an open combobox input.
   */
  function hasCommittedSelectValue(el, typedFilter = "") {
    // A multi-select holds its menu open after a pick, so the chip is the only
    // reliable signal that the value landed. Checking it first stops the caller
    // from "retrying" and stacking a second, contradictory choice.
    if (selectedChipTexts(el).length) return true;
    if (isDropdownMenuOpen(el)) return false;
    const shown = selectWidgetDisplayValue(el);
    const typed = normalize(typedFilter);
    if (shown && !isSelectPlaceholderText(shown)) {
      // React-Select single-value is a real commit.
      const root = getReactSelectRoot(el);
      if (
        root?.querySelector?.(
          ".select__single-value, [class*='select__single-value'], .select2-selection__rendered, [class*='singleValue']"
        )
      ) {
        return true;
      }
      if (typed && normalize(shown) === typed) {
        // Same as typed filter and menu closed — accept.
        return true;
      }
      if (!typed || normalize(shown) !== typed) return true;
    }
    const raw = String(el?.value || "").trim();
    if (!raw || isSelectPlaceholderText(raw) || isPlaceholderChoiceValue(raw)) return false;
    if (el?.tagName === "INPUT" && typed && normalize(raw) === typed) {
      // Typed filter text alone is not a committed option while we expected a pick.
      return false;
    }
    if (el?.tagName === "INPUT" && looksLikeCombobox(el)) return false;
    return true;
  }

  function setReactSelectFilter(input, text) {
    if (!input || input.tagName !== "INPUT") return;
    setNativeValue(input, text);
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
    );
    pressKey(input, String(text).slice(-1) || "a");
  }

  function clearReactSelectFilter(input) {
    if (!input || input.tagName !== "INPUT") return;
    setNativeValue(input, "");
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" })
    );
  }

  async function waitForOptions(attempts = 8, delayMs = 80) {
    for (let i = 0; i < attempts; i += 1) {
      const options = collectVisibleOptions(document);
      if (options.length) return options;
      await sleep(delayMs);
    }
    return [];
  }

  /** One patience round for an async suggestion list, and how many rounds we allow. */
  const COMBO_LIST_ROUND_MS = 500;
  const COMBO_LIST_ROUNDS = 4;

  /**
   * Wait for a combobox's suggestion list after typing.
   *
   * Slow widgets (Workday, iCIMS, async React-Select) fetch their options and can
   * blank the filter input while the request is in flight — if we press Enter/Tab
   * before the list paints, the typed text is thrown away and nothing is selected.
   * So: poll for a full round; if the list still is not up, retype the filter and
   * wait another round, up to `rounds` rounds.
   */
  async function waitForComboOptions(
    input,
    { retypeText = "", rounds = COMBO_LIST_ROUNDS, roundMs = COMBO_LIST_ROUND_MS } = {}
  ) {
    for (let round = 0; round < rounds; round += 1) {
      const deadline = Date.now() + roundMs;
      while (Date.now() < deadline) {
        const options = collectOptionsNearInput(input);
        if (options.length) return options;
        await sleep(150);
      }

      // Round elapsed with no list. Put the filter text back if the widget dropped
      // it, so the next round has something to match against.
      const wanted = String(retypeText || "").trim();
      if (!wanted || input?.tagName !== "INPUT") continue;
      if (normalize(input.value) === normalize(wanted)) continue;
      if (round + 1 >= rounds) continue;
      await typeIntoSelectFilter(input, wanted);
    }
    return [];
  }

  function pickFilteredOption(options, candidates, typed) {
    const match = options.find((n) => optionMatchesAny(n.textContent, candidates));
    if (match) return match;
    const typedNorm = normalize(typed);
    if (typedNorm) {
      const prefix = options.find((n) => normalize(n.textContent).startsWith(typedNorm));
      if (prefix) return prefix;
    }
    if (options.length === 1) return options[0];
    return firstHighlightedOption(activeSelectMenu()) || (typedNorm ? options[0] : null);
  }

  async function confirmSelectChoice(input, el, candidates, typedFilter = "") {
    if (selectLooksCommitted(el, candidates)) return true;
    const menu = activeSelectMenu();
    const highlighted = firstHighlightedOption(menu);
    if (highlighted) {
      clickOptionNode(highlighted);
      await sleep(120);
      if (selectLooksCommitted(el, candidates)) return true;
      if (hasCommittedSelectValue(el, typedFilter)) return true;
    }
    pressKey(input, "Enter", "Enter");
    await sleep(120);
    if (selectLooksCommitted(el, candidates)) return true;
    return hasCommittedSelectValue(el, typedFilter);
  }

  async function pickFirstVisibleOption(input, el, candidates = [], typedFilter = "") {
    let options = collectOptionsNearInput(input);
    if (!options.length) options = await waitForOptions(12, 100);
    // Still nothing: the list is probably still loading, so keep waiting rather
    // than giving up and leaving the typed text to be discarded.
    if (!options.length) {
      options = await waitForComboOptions(input, { retypeText: typedFilter, rounds: 2 });
    }
    if (!options.length) return false;

    const match =
      (candidates.length && options.find((n) => optionMatchesAny(n.textContent, candidates))) ||
      options[0];
    clickOptionNode(match);
    await sleep(150);
    if (selectLooksCommitted(el, candidates) || hasCommittedSelectValue(el, typedFilter)) {
      return true;
    }
    if (input) {
      pressKey(input, "ArrowDown", "ArrowDown");
      await sleep(80);
      pressKey(input, "Enter", "Enter");
      await sleep(150);
    }
    return selectLooksCommitted(el, candidates) || hasCommittedSelectValue(el, typedFilter);
  }

  /**
   * After typing into a combobox: wait for list → click match/first →
   * ArrowDown+Enter until the menu closes. Never treat typed filter text alone
   * as a successful selection while the list is still open.
   */
  async function commitTypedDropdown(input, el, candidates, { strict = false } = {}) {
    if (!input) return false;
    const typedFilter = String(input.value || candidates[0] || "").trim();
    // strict = the widget offers a fixed list of answers (demographics, Yes/No,
    // country…). There, an option that does not match what we meant to say is
    // simply the wrong answer, so we leave the field empty for the AI choice
    // pass rather than committing whatever happens to be first in the menu.
    const mustMatch = strict && candidates.length > 0;

    // Let the widget react to the last keystroke before we look for a list.
    await sleep(400);
    let options = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      options = collectOptionsNearInput(input);
      if (!options.length) options = collectVisibleOptions(document);
      if (!options.length) {
        // Never fall through to Enter/Tab while the list may still be loading —
        // that is what wipes the typed text on slow comboboxes.
        options = await waitForComboOptions(input, {
          retypeText: typedFilter,
          rounds: attempt === 0 ? COMBO_LIST_ROUNDS : 1
        });
      }
      const exact = options.find((n) => optionMatchesAny(n.textContent, candidates));
      if (mustMatch && options.length && !exact) return false;
      if (options.length) {
        const match = exact || pickFilteredOption(options, candidates, typedFilter) || options[0];
        clickOptionNode(match);
        await sleep(180);
        // On a multi-select the menu stays open by design — the chip, not the
        // closed menu, says the answer landed. Return before clicking anything else.
        if (selectLooksCommitted(el, candidates)) return true;
        if (isMultiSelectWidget(el) && selectedChipTexts(el).length) return true;
        if (!isDropdownMenuOpen(el) && hasCommittedSelectValue(el, typedFilter)) {
          return true;
        }
        // Some widgets need a second click on the same option.
        clickOptionNode(match);
        await sleep(120);
        if (selectLooksCommitted(el, candidates)) return true;
        if (!isDropdownMenuOpen(el) && hasCommittedSelectValue(el, typedFilter)) {
          return true;
        }
      }
      if (mustMatch) {
        // No usable list yet — wait another round rather than blind-committing
        // whatever the keyboard path would highlight.
        if (!options.length && attempt < 2) continue;
        return false;
      }

      // Keyboard path: highlight first suggestion then commit.
      try {
        input.focus({ preventScroll: true });
      } catch {
        try {
          input.focus();
        } catch {
          /* ignore */
        }
      }
      pressKey(input, "ArrowDown", "ArrowDown");
      await sleep(120);
      pressKey(input, "Enter", "Enter");
      await sleep(180);

      if (!isDropdownMenuOpen(el)) {
        if (selectLooksCommitted(el, candidates) || hasCommittedSelectValue(el, typedFilter)) {
          return true;
        }
        // Menu closed after Enter — accept if input holds a real value.
        const raw = String(el?.value || input.value || "").trim();
        if (raw && !isSelectPlaceholderText(raw)) return true;
      }
    }

    // Final force: click first visible option once more, then Enter, then blur.
    options = collectOptionsNearInput(input);
    if (!options.length) {
      options = await waitForComboOptions(input, { retypeText: typedFilter, rounds: 1 });
    }
    if (options.length) {
      clickOptionNode(options[0]);
      await sleep(150);
    }
    pressKey(input, "Enter", "Enter");
    await sleep(100);

    if (isDropdownMenuOpen(el)) {
      // Prefer Tab over Escape — Escape closes LinkedIn/Indeed apply modals.
      const before = selectWidgetDisplayValue(el);
      pressKey(input, "Tab", "Tab");
      await sleep(80);
      if (isDropdownMenuOpen(el)) {
        const inAppModal = Boolean(
          input?.closest?.('[role="dialog"], dialog, [aria-modal="true"], [class*="modal" i], [class*="Modal"]')
        );
        if (!inAppModal) {
          pressKey(input, "Escape", "Escape");
          await sleep(60);
        }
        if (!selectWidgetDisplayValue(el) && before) {
          /* ignore */
        }
      }
    }

    try {
      input.blur?.();
    } catch {
      /* ignore */
    }

    if (selectLooksCommitted(el, candidates)) return true;
    if (hasCommittedSelectValue(el, typedFilter)) return true;
    const raw = String(el?.value || input.value || "").trim();
    return Boolean(raw && !isSelectPlaceholderText(raw) && !isDropdownMenuOpen(el));
  }

  async function fillAsyncAutocomplete(el, value, key = null) {
    if (value == null || String(value).trim() === "") return false;
    const candidates = key ? expandValueCandidates(key, value) : [String(value).trim()];
    const filterText = String(candidates.find((c) => String(c).trim()) || "").trim();
    if (!filterText) return false;

    const listId = el.getAttribute("list");
    if (listId) {
      const dl = document.getElementById(listId);
      if (dl) {
        const opts = [...dl.querySelectorAll("option")];
        const match =
          opts.find((o) => optionMatchesAny(o.value || o.textContent, candidates)) || opts[0];
        if (match) {
          setNativeValue(el, match.value || match.textContent);
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
    }

    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    await typeIntoSelectFilter(el, filterText);
    return commitTypedDropdown(el, el, candidates);
  }

  async function fillCustomDropdown(el, value, key = null) {
    if (value == null || String(value).trim() === "") return false;
    const candidates = key ? expandValueCandidates(key, value) : [String(value).trim()];
    const reactSelect = isReactSelectInput(el) || isSelectPlaceholderWidget(el);

    const native = el.closest?.("label, .field, .form-field, [class*='question']")?.querySelector?.(
      "select"
    );
    if (native && fillSelect(native, value, key) && selectLooksCommitted(el, candidates)) {
      return true;
    }

    const multi = isMultiSelectWidget(el);
    const committed = () =>
      selectLooksCommitted(el, candidates) ||
      (multi && selectedChipTexts(el).length > 0) ||
      !isDropdownMenuOpen(el);

    let options = collectVisibleOptions(document);
    let match = options.find((n) => optionMatchesAny(n.textContent, candidates));
    if (match) {
      clickOptionNode(match);
      await sleep(120);
      if (committed()) return true;
    }

    const input = openReactSelect(el);
    options = await waitForOptions(reactSelect ? 14 : 8, reactSelect ? 100 : 80);
    match = options.find((n) => optionMatchesAny(n.textContent, candidates));
    if (match) {
      clickOptionNode(match);
      await sleep(150);
      if (committed()) {
        if (reactSelect) clearReactSelectFilter(input);
        return true;
      }
    }
    // Deliberately no "click the first option" fallback here. This widget has a
    // fixed answer list; if nothing matches, the honest outcome is an empty field
    // that the AI choice pass then answers from the real options.

    const filterText = isYesNoValue(candidates[0])
      ? YES_VALUES.has(normalize(candidates[0]))
        ? "Yes"
        : "No"
      : String(
          candidates.find((c) => String(c).trim().length >= 1) || candidates[0] || ""
        ).trim();

    if (input && input.tagName === "INPUT" && filterText) {
      await typeIntoSelectFilter(input, filterText);
      const ok = await commitTypedDropdown(input, el, candidates, { strict: true });
      if (ok) {
        if (reactSelect && !isDropdownMenuOpen(el)) clearReactSelectFilter(input);
        return true;
      }
      // Nothing in the list said what we meant. Clear the typed filter so the
      // field is left genuinely empty instead of holding free text no option matches.
      if (reactSelect) clearReactSelectFilter(input);
    } else if (input) {
      const ok = await commitTypedDropdown(input, el, candidates, { strict: true });
      if (ok) return true;
    }

    if (native && fillSelect(native, value, key)) return true;
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

      if (looksLikeAsyncAutocomplete(el)) {
        return fillAsyncAutocomplete(el, value, key);
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
    const dice = /(^|\.)dice\.com$/i.test(location.hostname);
    // Dice upload step: attach files, wait 0.5s, continue — no long spinner loops.
    if (dice) {
      await sleep(Math.min(500, Math.max(0, Number(timeoutMs) || 500)));
      return !uploadsStillBusy();
    }
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
    const dice = /(^|\.)dice\.com$/i.test(location.hostname);
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
      await sleep(dice ? 100 : 200);
      const ok = setFileOnInput(row.input, row.file);
      if (ok) {
        used.add(row.input);
        uploaded.push({
          kind: row.kind,
          fileName: row.file.name,
          label: row.label
        });
        if (dice) {
          // Brief gap between resume / cover letter attaches only.
          await sleep(100);
        } else {
          // Wait for each file to finish before attaching the next / clicking Next.
          await waitForUploadsToSettle(row.kind === "coverLetter" ? 25000 : 20000);
        }
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

    const settled = await waitForUploadsToSettle(dice ? 500 : 8000);
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
    if (isReactSelectInput(el) || looksLikeCombobox(el) || isSelectPlaceholderWidget(el)) return true;
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
      const placeholder = cleanLabelText(el.getAttribute("placeholder") || el.getAttribute("aria-placeholder"));
      const hasUsefulLabel =
        String(questionLabel || labelNorm || placeholder || identityHintFromControl(el)).trim().length >= 3;
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
      // Combobox / React-Select must never receive free-text AI answers —
      // those go through the choice/Q&A path. Async autocomplete may still fill.
      if (isReactSelectInput(el) || (looksLikeCombobox(el) && !looksLikeAsyncAutocomplete(el))) {
        el.removeAttribute("data-resume-bot-qid");
        continue;
      }
      if (/^(yes|no)([.,!]|$)/i.test(answer)) {
        const label = questionLabelForControl(el) || labelTextForControl(el);
        const isChoice =
          el.type === "checkbox" ||
          el.type === "radio" ||
          el.tagName === "SELECT" ||
          looksLikeCombobox(el) ||
          isSelectPlaceholderWidget(el);
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
        await pauseBetweenFields();
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

      // Emptiness, not "is this a known field", decides. The deterministic pass
      // runs first, so a mapped control that is STILL empty means the profile
      // answer matched none of this form's options — exactly the case the AI
      // choice pass exists for.
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
      // Same rule as above: only skip a mapped combobox once it actually holds a value.
      if (selectedChipTexts(el).length) continue;
      if (String(el.value || "").trim() && !isPlaceholderChoiceValue(el.value)) continue;
      const shownValue = selectWidgetDisplayValue(el);
      if (shownValue && !isSelectPlaceholderText(shownValue)) continue;

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
          // Close menu without Escape inside apply modals (Escape closes the whole dialog).
          const input = isReactSelectInput(el) ? el : el.querySelector?.("input") || el;
          if (input) {
            const inAppModal = Boolean(
              input.closest?.('[role="dialog"], dialog, [aria-modal="true"], [class*="modal" i], [class*="Modal"]')
            );
            pressKey(input, "Tab", "Tab");
            if (!inAppModal) {
              input.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" })
              );
            }
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
      if (ok) {
        filled.push({ id, preview: answer.slice(0, 80) });
        await pauseBetweenFields();
      }
    }
    return { filledCount: filled.length, filled };
  }

  function collectFillableControls() {
    const nodes = [
      ...document.querySelectorAll(
        'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"], .select__control, [class*="select__control"], input[placeholder^="Select" i], [aria-placeholder^="Select" i], .select2-search__field'
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

  /**
   * Required according to the form itself. Only trust markup the ATS sets — a
   * page-level "* indicates a required field" note would otherwise make every
   * field look mandatory and stall the run forever.
   */
  function controlIsRequired(el) {
    if (!el) return false;
    if (el.required === true) return true;
    const attr = (name) => String(el.getAttribute?.(name) || "").trim().toLowerCase();
    if (attr("aria-required") === "true") return true;
    // Validation already rejected this field, so it is required in practice.
    if (attr("aria-invalid") === "true") return true;
    return /\brequired\b/.test(String(el.className || ""));
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
      if (!country || /united states|usa|\bus\b/i.test(country)) {
        return "United States of America (+1)";
      }
    }
    // A required Country selector left blank blocks the whole form. These are US
    // applications, so fall back to the US rather than skipping the field.
    if (key === "country") return "United States";
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

  /**
   * Second pass: fill empty dropdowns/radios using profile defaults + rule-based keys.
   * `explicitOnly` uses only values the profile actually holds — after an AI form
   * plan, the blank-profile Yes/No defaults must not overrule the model.
   */
  async function fillRemainingChoiceControls(applicantInfo = {}, { explicitOnly = false } = {}) {
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
      const value = explicitOnly
        ? String(applicantInfo?.[key] ?? "").trim()
        : resolveApplicantValue(applicantInfo, key);
      if (!value) continue;
      if (await fillControl(el, value, key)) {
        filled.push({ key, label: questionLabelForControl(el) });
        await pauseBetweenFields();
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
    const label = normalize(
      [
        questionLabelForControl(el),
        labelTextForControl(el),
        el.getAttribute?.("placeholder") || "",
        identityHintFromControl(el)
      ]
        .filter(Boolean)
        .join(" ")
    );
    const ctx = `${label} ${historyContext(el)}`;
    const nameBlob = normalize([el.name, el.id, identityHintFromControl(el)].join(" "));
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
      if (
        (/\b(company|employer|organization|organisation)\b/.test(ctx) ||
          /\b(company name|employer name|organization name)\b/.test(nameBlob)) &&
        !/\b(email|phone|website)\b/.test(ctx)
      ) {
        return "company";
      }
      if (
        /^(title|role|position)$/.test(label) ||
        /\b(job title|position title|role title|title of (the )?(job|role|position)|position held)\b/.test(ctx) ||
        /\b(job title|position title|role title)\b/.test(nameBlob)
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
      if (await fillHistoryValue(el, values)) {
        filled.push(kind);
        await pauseBetweenFields();
      }
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

  /**
   * @param {{ mode?: "legacy" | "plan" }} [options] In "plan" mode only identity,
   *   contact and location fields are filled by rule here. Every other field is
   *   left for the AI form planner, which sees the whole form with its real
   *   option lists (scan_application_form → apply_form_plan).
   */
  async function autofillApplication(
    applicantInfo = {},
    uploadFiles = {},
    credentials = {},
    history = {},
    { mode = "legacy" } = {}
  ) {
    const planMode = mode === "plan";
    // #region agent log
    const autofillStartedAt = Date.now();
    fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "30a7bc" },
      body: JSON.stringify({
        sessionId: "30a7bc",
        runId: "post-fix",
        hypothesisId: "F",
        location: "content/autofill.js:autofillApplication:start",
        message: "Autofill started",
        data: { url: location.href, build: SCRIPT_BUILD },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    suppressLearn();
    const filled = [];
    const wd = isWorkdayPage() ? detectWorkdayWizardState() : null;
    const shouldFillHistory =
      !wd || wd.isExperience || wd.isEducation || looksLikeHistoryForm();

    // Top → bottom: attach docs first unless this is a Workday Review page
    // with no file inputs (avoids hunting upload UI on confirmation steps).
    const uploadResult =
      wd?.isReview && !collectFileInputs().length
        ? { uploadedCount: 0, uploaded: [], skipped: [], settled: true }
        : await uploadApplicationFiles(uploadFiles);

    const historyFilled = shouldFillHistory
      ? await fillHistorySections(history.workHistory, history.educationHistory)
      : [];
    for (const row of historyFilled) filled.push(row);

    const controls = collectFillableControls();

    for (const el of controls) {
      if (isHistoryFilled(el)) continue;
      const label = labelTextForControl(el);
      const key = matchApplicantKeyFromControl(el);
      if (!key) continue;
      // Plan mode: rules only own who and where the candidate is. Screening,
      // eligibility, EEO and experience fields go to the AI planner, which
      // picks from the form's real options instead of guessing "Yes".
      if (planMode && !PLAN_MODE_RULE_KEYS.has(key)) continue;
      const value = resolveApplicantValue(applicantInfo, key);
      if (!value) continue;
      if (await fillControl(el, value, key)) {
        filled.push({ key, label });
        await pauseBetweenFields();
      }
    }

    if (!planMode) {
      const choicePass = await fillRemainingChoiceControls(applicantInfo);
      for (const row of choicePass.filled || []) filled.push(row);
    }

    // Fill saved login/sign-up credentials when this page has a Create Login section.
    const creds = {
      email: String(credentials.email || applicantInfo.email || "").trim(),
      username: String(credentials.username || "").trim(),
      password: String(credentials.password || "")
    };
    const credResult = fillLoginCredentials(creds);
    if ((isWorkdayPage() || isBuiltInPage()) && credResult.filledCount > 0) {
      const authSubmit = queryAllDeep("button, a, [role='button'], input[type='submit']").find(
        (el) => {
          if (!isElVisible(el) || !isElEnabled(el)) return false;
          const t = elActionText(el);
          return /^(create account|create an account|sign in|log in|register|continue)$/i.test(
            t.trim()
          );
        }
      );
      if (authSubmit) {
        scrollElIntoView(authSubmit);
        safeClick(authSubmit);
        await sleep(1600);
      }
    }

    // One more quiet check so Next is never pressed mid-upload.
    if (uploadResult.uploadedCount > 0 || uploadsStillBusy()) {
      const dice = /(^|\.)dice\.com$/i.test(location.hostname);
      await waitForUploadsToSettle(dice ? 500 : 12000);
    }

    // Plan mode reads the page with scan_application_form instead.
    const unmatchedQuestions = planMode ? [] : collectUnmatchedQuestions(applicantInfo);
    const unmatchedChoiceQuestions = planMode ? [] : await collectUnmatchedChoiceQuestions();

    const result = {
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
      unmatchedChoiceQuestions,
      workdayWizard: wd
    };
    // #region agent log
    fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "30a7bc" },
      body: JSON.stringify({
        sessionId: "30a7bc",
        runId: "post-fix",
        hypothesisId: "F",
        location: "content/autofill.js:autofillApplication:end",
        message: "Autofill finished",
        data: {
          ms: Date.now() - autofillStartedAt,
          filledCount: result.filledCount,
          unmatched: unmatchedQuestions.length
        },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    return result;
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
      if (isMarketingOrCorporateHref(url) || !isApplyRelatedHref(url)) return;
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
      // Reliable fallback when Apply is a <button> with no href: build the wizard URL.
      if (isDiceJobBrowsePage()) {
        const wizard = diceApplicationWizardUrl();
        if (wizard) pushUrl(wizard);
      }
    }

    if (applyUrls.length < 5 && isGreenhousePage()) {
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          if (/job_app|\/apply\b|embed\/job/i.test(a.href || "")) pushUrl(a.href);
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    if (applyUrls.length < 5 && isWorkdayPage()) {
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          if (/\/apply\b|jobPostingApply|application/i.test(a.href || "")) pushUrl(a.href);
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    if (applyUrls.length < 5 && isJobgetherPage()) {
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          const href = a.href || "";
          if (
            /smartrecruiters\.com|zohorecruit\.com|recruit\.zoho\.|oraclecloud\.com/i.test(href)
          ) {
            pushUrl(href);
          }
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    // Jobright hands off to an employer ATS. Surface the external apply link so
    // the SW can open it directly when the CTA is a plain anchor.
    if (applyUrls.length < 5 && isJobrightPage()) {
      for (const a of document.querySelectorAll("a[href]")) {
        try {
          const href = a.href || "";
          if (!/^https?:\/\//i.test(href)) continue;
          if (/(^|\.)jobright\.ai$/i.test(new URL(href).hostname)) continue;
          const text = String(a.textContent || a.getAttribute("aria-label") || "").trim();
          const hint = `${a.getAttribute("title") || ""} ${a.id || ""} ${a.className || ""}`;
          if (JOBRIGHT_JUNK_RE.test(text) || JOBRIGHT_JUNK_RE.test(hint)) continue;
          if (APPLY_NOW_RE.test(text) || JOBGETHER_APPLY_RE.test(text) || /apply/i.test(hint)) {
            pushUrl(href);
          }
        } catch {
          /* ignore */
        }
        if (applyUrls.length >= 5) break;
      }
    }

    return applyUrls;
  }

  function isIndeedPage(url = location.href) {
    try {
      return /(^|\.)indeed\.com$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isWorkdayPage(url = location.href) {
    try {
      const host = new URL(String(url || location.href)).hostname.toLowerCase();
      return /(^|\.)myworkdayjobs\.com$/.test(host) || /(^|\.)workdayjobs\.com$/.test(host);
    } catch {
      return false;
    }
  }

  function isGreenhousePage(url = location.href) {
    try {
      return /(^|\.)greenhouse\.io$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isJobgetherPage(url = location.href) {
    try {
      return /(^|\.)jobgether\.com$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isJobrightPage(url = location.href) {
    try {
      return /(^|\.)jobright\.ai$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isLinkedInApplyUrl(url = "") {
    try {
      const href = String(url || "").trim();
      if (!href) return false;
      const host = new URL(href, location.href).hostname.toLowerCase();
      return /(^|\.)linkedin\.com$/i.test(host);
    } catch {
      return /linkedin\.com/i.test(String(url || ""));
    }
  }

  /**
   * Jobright → LinkedIn Easy Apply destinations are not auto-applied.
   * Reads Apply Now hrefs plus applyLink / originalUrl from page JSON.
   */
  function detectJobrightLinkedInApply() {
    if (!isJobrightPage()) return "";
    const candidates = [];

    const push = (raw) => {
      const href = String(raw || "").trim();
      if (!href || !isLinkedInApplyUrl(href)) return;
      try {
        candidates.push(new URL(href, location.href).toString());
      } catch {
        candidates.push(href);
      }
    };

    for (const sel of ["jobright-helper-job-detail-info", "__NEXT_DATA__", "job-posting"]) {
      try {
        const el = document.getElementById(sel) || document.querySelector(`script#${sel}`);
        const raw = el?.textContent || "";
        if (!raw) continue;
        const data = JSON.parse(raw);
        const jr =
          data?.jobResult ||
          data?.props?.pageProps?.dataSource?.jobResult ||
          data ||
          {};
        push(jr.applyLink || jr.originalUrl || data?.url || "");
      } catch {
        /* ignore parse errors */
      }
    }

    for (const el of visibleActionControls()) {
      const text = elActionText(el);
      if (JOBRIGHT_JUNK_RE.test(text)) continue;
      const isApply =
        APPLY_NOW_RE.test(text) ||
        JOBGETHER_APPLY_RE.test(text) ||
        /^\s*apply\s+externally\s*$/i.test(text);
      if (!isApply) continue;
      push(el.href || el.getAttribute?.("href") || el.getAttribute?.("formaction") || "");
    }

    for (const u of collectApplyUrlCandidates()) push(u);

    return candidates[0] || "";
  }

  function isBuiltInPage(url = location.href) {
    try {
      return /(^|\.)builtin\.com$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isZipRecruiterPage(url = location.href) {
    try {
      return /(^|\.)ziprecruiter\.com$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isBuiltInAuthPage() {
    return isBuiltInPage() && Boolean(document.querySelector('input[type="password"]'));
  }

  function isSmartRecruitersPage(url = location.href) {
    try {
      return /(^|\.)smartrecruiters\.com$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isZohoRecruitPage(url = location.href) {
    try {
      const host = new URL(String(url || location.href)).hostname.toLowerCase();
      return /(^|\.)zohorecruit\.com$/.test(host) || /(^|\.)recruit\.zoho\./.test(host);
    } catch {
      return false;
    }
  }

  function isOracleCloudPage(url = location.href) {
    try {
      return /(^|\.)oraclecloud\.com$/i.test(new URL(String(url || location.href)).hostname);
    } catch {
      return false;
    }
  }

  function isAtsGatewayPage(url = location.href) {
    return isSmartRecruitersPage(url) || isZohoRecruitPage(url) || isOracleCloudPage(url);
  }

  function applyPageSite(url = location.href) {
    if (isIndeedPage(url)) return "indeed";
    if (isWorkdayPage(url)) return "workday";
    if (isGreenhousePage(url)) return "greenhouse";
    if (isJobrightPage(url)) return "jobright";
    if (isJobgetherPage(url)) return "jobgether";
    if (isBuiltInPage(url)) return "builtin";
    if (isZipRecruiterPage(url)) return "ziprecruiter";
    if (isSmartRecruitersPage(url)) return "smartrecruiters";
    if (isZohoRecruitPage(url)) return "zohorecruit";
    if (isOracleCloudPage(url)) return "oraclecloud";
    try {
      if (/(^|\.)dice\.com$/i.test(new URL(String(url || location.href)).hostname)) return "dice";
    } catch {
      /* ignore */
    }
    return "generic";
  }

  function isSameSiteApplyUrl(url, site = "") {
    try {
      const target = new URL(String(url || ""), location.href);
      if (!/^https?:$/i.test(target.protocol)) return false;
      if (site === "indeed") return /(^|\.)indeed\.com$/i.test(target.hostname);
      if (site === "dice") return /(^|\.)dice\.com$/i.test(target.hostname);
      if (site === "workday") {
        return (
          /(^|\.)myworkdayjobs\.com$/i.test(target.hostname) ||
          /(^|\.)workdayjobs\.com$/i.test(target.hostname)
        );
      }
      if (site === "greenhouse") return /(^|\.)greenhouse\.io$/i.test(target.hostname);
      if (site === "jobgether") return /(^|\.)jobgether\.com$/i.test(target.hostname);
      if (site === "jobright") return /(^|\.)jobright\.ai$/i.test(target.hostname);
      if (site === "builtin") return /(^|\.)builtin\.com$/i.test(target.hostname);
      if (site === "ziprecruiter") return /(^|\.)ziprecruiter\.com$/i.test(target.hostname);
      if (site === "smartrecruiters") return /(^|\.)smartrecruiters\.com$/i.test(target.hostname);
      if (site === "zohorecruit") {
        return /(^|\.)zohorecruit\.com$/i.test(target.hostname) || /(^|\.)recruit\.zoho\./i.test(target.hostname);
      }
      if (site === "oraclecloud") return /(^|\.)oraclecloud\.com$/i.test(target.hostname);
      return target.origin === location.origin;
    } catch {
      return false;
    }
  }

  /**
   * True only for an interactive CAPTCHA the user must solve — not the Google
   * privacy badge or invisible reCAPTCHA tokens Greenhouse embeds by default.
   */
  function hasActiveCaptchaChallenge() {
    for (const iframe of queryAllDeep(
      'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha.com"][src*="challenge"], iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i]'
    )) {
      if (!isElVisible(iframe)) continue;
      const w = iframe.offsetWidth || 0;
      const h = iframe.offsetHeight || 0;
      if (w >= 120 && h >= 80) return true;
    }

    for (const host of queryAllDeep(
      ".g-recaptcha, #g-recaptcha, [data-sitekey], .h-captcha, .cf-turnstile"
    )) {
      if (!isElVisible(host)) continue;
      if (host.classList?.contains("grecaptcha-badge")) continue;
      if (host.closest?.(".grecaptcha-badge")) continue;
      const w = host.offsetWidth || 0;
      const h = host.offsetHeight || 0;
      if (w >= 100 && h >= 40) return true;
      const anchor = host.querySelector?.('iframe[src*="anchor"]');
      if (anchor && isElVisible(anchor) && (anchor.offsetWidth || 0) >= 100) return true;
    }

    const bodyText = cleanLabelText(document.body?.innerText || "").slice(0, 4000);
    if (
      /\b(select all (?:images|squares)|i'?m not a robot|verify you are human|complete the captcha)\b/i.test(
        bodyText
      )
    ) {
      const frame = document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
      );
      if (frame && isElVisible(frame) && (frame.offsetWidth || 0) >= 100) return true;
    }

    return false;
  }

  function detectPageBlocker() {
    const href = String(location.href || "");
    // Workday create-account / sign-in is handled by credential autofill.
    if (isWorkdayPage()) {
      if (hasActiveCaptchaChallenge()) {
        return "A CAPTCHA is on the page. Solve it, then retry.";
      }
      return "";
    }
    // Built In Easy Apply may ask for login mid-flow — credentials are filled during autofill.
    if (document.querySelector('input[type="password"]') && !isBuiltInPage()) {
      return "A sign-in form is on the page. Log in, then retry.";
    }
    if (isIndeedPage() && /\/account\/login|\/auth|\/m\/basecamp/i.test(href)) {
      return "A sign-in form is on the page. Log in, then retry.";
    }
    if (hasActiveCaptchaChallenge()) {
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

  /** Dice closed posting: div.alert-type-page with "no longer available" / similar jobs copy. */
  function detectDiceUnavailableAlert() {
    const host = String(location.hostname || "").toLowerCase();
    if (!host.endsWith("dice.com")) return "";

    const isVisible = (el) => {
      if (!el) return false;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect?.();
        if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
      } catch {
        /* ignore */
      }
      return true;
    };

    const messageFromText = (text) => {
      const clean = cleanLabelText(text);
      if (!clean) return "";
      if (
        JOB_GONE_RE.test(clean) ||
        /sorry[, ]*this job is no longer available/i.test(clean) ||
        /similar jobs shown below might interest you/i.test(clean)
      ) {
        return clean.slice(0, 200) || "This job is no longer available.";
      }
      return "";
    };

    // Primary: Dice banner container (class alert-type-page).
    const alerts = document.querySelectorAll(
      ".alert-type-page, div.alert-type-page, [class*='alert-type-page']"
    );
    for (const el of alerts) {
      if (!isVisible(el)) continue;
      const hit = messageFromText(el.textContent);
      if (hit) return hit;
    }

    // Fallback: closed-job copy rendered without the alert wrapper.
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    if (
      /sorry[, ]*this job is no longer available/i.test(bodyText) &&
      /similar jobs shown below might interest you/i.test(bodyText)
    ) {
      const match = bodyText.match(
        /sorry[^.!?]*(?:no longer available|similar jobs shown below)[^.!?]*[.!?]?/i
      );
      return cleanLabelText(match ? match[0] : bodyText).slice(0, 200);
    }

    return "";
  }

  /** @returns {string} a short reason when the job is gone, else "" */
  function detectJobUnavailable() {
    const jobrightClosed = detectJobrightExpiredBadge();
    if (jobrightClosed) return jobrightClosed;

    const diceClosed = detectDiceUnavailableAlert();
    if (diceClosed) return diceClosed;

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
    const hasIndeedApplyUi =
      isIndeedPage() &&
      Boolean(
        document.querySelector(
          [
            "#indeedApplyButton",
            "[data-testid='indeedApplyButton']",
            "[data-testid*='ApplyForm']",
            "[class*='ia-ApplyForm']",
            "[class*='ia-BasePage']",
            "[data-indeed-apply-joburl]"
          ].join(", ")
        )
      );

    const isGreenhouseApplyPage =
      isGreenhousePage() &&
      (/job_app|\/apply/i.test(pathAndQuery) ||
        hasFileInput ||
        identityFields >= 2 ||
        (hasApplyForm && fillableCount >= 2));

    const isWorkdayApplyPage =
      isWorkdayPage() &&
      (/\/apply\//i.test(location.href) ||
        Boolean(
          document.querySelector(
            '[data-automation-id*="formField"], [data-automation-id="applyManual"], [data-automation-id*="apply"]'
          )
        ));

    // Dice job cards / job-detail pages have newsletter and ad forms. Those are
    // not the application. Only the /job-applications wizard is.
    let isApplicationForm = isDiceHost
      ? Boolean(isDiceApplyPage)
      : Boolean(
          hasFileInput ||
            identityFields >= 2 ||
            (hasApplyForm && fillableCount >= 2) ||
            (hasIndeedApplyUi && fillableCount >= 1) ||
            isGreenhouseApplyPage ||
            isWorkdayApplyPage ||
            looksLikeHistoryForm()
        );
    // Jobright/Jobgether are gateways: the listing page is never the application
    // form itself — the real form lives on the employer ATS they open.
    if (isJobgetherPage() || isJobrightPage()) isApplicationForm = false;
    // Built In job detail is a gateway until Easy Apply opens (or auth is required).
    if (
      isBuiltInPage() &&
      !isBuiltInAuthPage() &&
      identityFields < 2 &&
      !hasFileInput &&
      fillableCount < 2
    ) {
      isApplicationForm = false;
    }
    // ZipRecruiter JD page is not the application form until a multi-step flow opens.
    if (isZipRecruiterPage() && identityFields < 2 && !hasFileInput && fillableCount < 2) {
      isApplicationForm = false;
    }
    if (isBuiltInAuthPage()) isApplicationForm = true;
    if (
      (isSmartRecruitersPage() || isZohoRecruitPage() || isOracleCloudPage()) &&
      identityFields < 2 &&
      !hasFileInput
    ) {
      isApplicationForm = false;
    }

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
      alreadyApplied:
        detectDiceAlreadyApplied() ||
        detectJobrightAlreadyApplied() ||
        detectZipRecruiterAlreadyApplied(),
      oneClickApply: detectZipRecruiterOneClickOnly(),
      linkedinRedirect: detectJobrightLinkedInApply(),
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

  /** Job id from Dice job-detail / search URLs (for /job-applications/{id}/wizard). */
  function extractDiceJobId(url = location.href) {
    try {
      const u = new URL(String(url || ""), location.href);
      if (!/(^|\.)dice\.com$/i.test(u.hostname)) return "";
      const selected =
        u.searchParams.get("selectedJobId") ||
        u.searchParams.get("jobId") ||
        u.searchParams.get("id") ||
        "";
      if (selected) return String(selected).trim();
      const parts = u.pathname.split("/").filter(Boolean);
      const detailIdx = parts.findIndex((p) => p === "job-detail" || p === "detail");
      if (detailIdx >= 0 && parts[detailIdx + 1]) {
        // Legacy: /job-detail/{slug}/{id}
        if (parts[detailIdx] === "job-detail" && parts[detailIdx + 2]) {
          return String(parts[detailIdx + 2]).trim();
        }
        return String(parts[detailIdx + 1]).trim();
      }
      const appIdx = parts.findIndex((p) => p === "job-applications");
      if (appIdx >= 0 && parts[appIdx + 1]) return String(parts[appIdx + 1]).trim();
    } catch {
      /* ignore */
    }
    return "";
  }

  function diceApplicationWizardUrl(url = location.href) {
    const id = extractDiceJobId(url);
    if (!id) return "";
    return `https://www.dice.com/job-applications/${encodeURIComponent(id)}/wizard`;
  }

  const INDEED_APPLY_SUCCESS_RE =
    /\b(application submitted|your application (?:has been )?(?:submitted|sent)|application (?:has been )?(?:sent|received)|you(?:'|’)ve applied|successfully applied)\b/i;
  const WORKDAY_APPLY_SUCCESS_RE =
    /\b(application\s+(?:has\s+been\s+)?(?:submitted|received|sent)|thank you for (?:applying|your application)|you(?:'|’)ve successfully applied|successfully submitted your application)\b/i;
  const GREENHOUSE_APPLY_SUCCESS_RE =
    /\b(you(?:'|’)re in the race|your application has been received|application has been received|thank you for applying|successfully submitted|application (?:was |has been )?submitted)\b/i;

  function detectIndeedApplySuccess() {
    if (!isIndeedPage()) return "";
    const href = String(location.href || "");
    const successUrl = /\/apply\/(?:complete|success|submitted)|applicationSubmitted/i.test(href);
    const candidates = queryAllDeep(
      [
        '[data-testid*="success" i]',
        '[data-testid*="confirmation" i]',
        '[class*="application-success" i]',
        '[class*="confirmation" i]',
        '[role="status"]',
        '[role="alert"]',
        "h1",
        "h2",
        '[role="heading"]'
      ].join(", ")
    )
      .map((el) => cleanLabelText(el.textContent || ""))
      .filter((text) => text && text.length <= 500);
    const hit = candidates.find((text) => INDEED_APPLY_SUCCESS_RE.test(text));
    if (!successUrl && !hit) return "";
    return (hit || "Application submitted").slice(0, 160);
  }

  function detectWorkdayApplySuccess() {
    if (!isWorkdayPage()) return "";
    const href = String(location.href || "");
    const successUrl = /\/apply\/(?:complete|submitted|success)|applicationSubmitted|\/submitted/i.test(href);
    const bodyText = cleanLabelText(document.body?.innerText || document.body?.textContent || "");
    const headings = queryAllDeep("h1, h2, [role='heading']")
      .map((el) => cleanLabelText(el.textContent))
      .filter(Boolean);
    const headingHit = headings.find((t) => WORKDAY_APPLY_SUCCESS_RE.test(t));
    const bodyHit = bodyText ? bodyText.match(WORKDAY_APPLY_SUCCESS_RE) : null;
    if (!successUrl && !headingHit && !bodyHit) return "";
    return (headingHit || (bodyHit && bodyHit[0]) || "Application submitted").slice(0, 160);
  }

  function detectGreenhouseEmailVerification() {
    if (!isGreenhousePage()) return { ok: false };
    const bodyText = cleanLabelText(document.body?.innerText || document.body?.textContent || "");
    const hasCopy =
      /\b(security\s*code|verification\s*code|enter\s+(?:the\s+)?(?:\d+[-\s]?)?character\s+code|confirm you(?:'|’)re a human|copy\s+and\s+paste\s+this\s+code|resubmit your application)\b/i.test(
        bodyText
      );
    const boxes = findGreenhouseSecurityCodeBoxes();
    const codeInput = boxes[0] || findGreenhouseSecurityCodeInput();
    if (!hasCopy && !codeInput && !boxes.length) return { ok: false };
    if (!codeInput && !boxes.length && !/\bsecurity\s*code\b/i.test(bodyText)) return { ok: false };
    return { ok: true, text: "Greenhouse security code verification" };
  }

  function findGreenhouseSecurityCodeBoxes() {
    const inputs = queryAllDeep(
      'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"])'
    ).filter((el) => isElVisible(el) && !el.disabled);

    const isOtpCharInput = (el) => {
      const maxLen = Number(el.getAttribute("maxlength") || el.maxLength || 0);
      const pattern = String(el.getAttribute("pattern") || "");
      const auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
      const inputMode = String(el.getAttribute("inputmode") || "").toLowerCase();
      const name = normalize(
        [el.name || "", el.id || "", el.getAttribute("aria-label") || ""].join(" ")
      );
      if (/email|phone|password|search|first|last|name|linkedin/i.test(name)) return false;
      if (auto.includes("one-time-code")) return true;
      if (maxLen === 1) return true;
      if (/^\.?[a-z0-9]$/i.test(pattern) || pattern.includes("{1}")) return true;
      if (inputMode === "numeric" || inputMode === "text") {
        if (maxLen > 0 && maxLen <= 2) return true;
      }
      return false;
    };

    const labeled = inputs.filter((el) => {
      const blob = normalize(
        [
          questionLabelForControl(el),
          labelTextForControl(el),
          el.getAttribute?.("aria-label") || "",
          el.closest?.("fieldset")?.querySelector?.("legend")?.textContent || ""
        ].join(" ")
      );
      return /\b(security\s*code|verification\s*code|one[- ]time|otp)\b/.test(blob);
    });
    const labeledBoxes = labeled.filter(isOtpCharInput);
    if (labeledBoxes.length >= 4) return labeledBoxes.slice(0, 12);

    const singles = inputs.filter(isOtpCharInput);
    if (singles.length >= 4) {
      const byParent = new Map();
      for (const el of singles) {
        const parent = el.parentElement;
        if (!parent) continue;
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(el);
      }
      let best = [];
      for (const group of byParent.values()) {
        if (group.length >= 4 && group.length > best.length) best = group;
      }
      if (best.length >= 4) return best.slice(0, 12);
      const byGrand = new Map();
      for (const el of singles) {
        const grand = el.parentElement?.parentElement;
        if (!grand) continue;
        if (!byGrand.has(grand)) byGrand.set(grand, []);
        byGrand.get(grand).push(el);
      }
      best = [];
      for (const group of byGrand.values()) {
        if (group.length >= 4 && group.length > best.length) best = group;
      }
      if (best.length >= 4) return best.slice(0, 12);
      if (singles.length >= 6 && singles.length <= 10) return singles.slice(0, 12);
    }
    return [];
  }

  function findGreenhouseSecurityCodeInput() {
    const boxes = findGreenhouseSecurityCodeBoxes();
    if (boxes.length === 1) return boxes[0];

    const inputs = queryAllDeep('input:not([type="hidden"]):not([type="file"]), textarea');
    for (const el of inputs) {
      if (!isElVisible(el) || el.disabled) continue;
      if (boxes.includes(el)) continue;
      const blob = normalize(
        [
          questionLabelForControl(el),
          labelTextForControl(el),
          el.getAttribute?.("aria-label") || "",
          el.getAttribute?.("placeholder") || "",
          el.name || "",
          el.id || "",
          el.getAttribute?.("autocomplete") || ""
        ].join(" ")
      );
      if (/\b(security\s*code|verification\s*code|one[- ]time|otp|email\s*code)\b/.test(blob)) {
        const maxLen = Number(el.getAttribute("maxlength") || el.maxLength || 0);
        if (!maxLen || maxLen >= 4) return el;
      }
    }
    const bodyText = cleanLabelText(document.body?.innerText || "");
    if (!/\bsecurity\s*code\b/i.test(bodyText)) return null;
    if (boxes.length >= 4) return null;
    const candidates = inputs.filter(
      (el) =>
        isElVisible(el) &&
        !el.disabled &&
        /^(text|tel|search|)$/i.test(String(el.type || "text")) &&
        !/email|phone|name|password/i.test(
          normalize([el.name, el.id, el.getAttribute?.("autocomplete") || ""].join(" "))
        )
    );
    const full = candidates.find((el) => {
      const maxLen = Number(el.getAttribute("maxlength") || el.maxLength || 0);
      return !maxLen || maxLen >= 4;
    });
    return full || null;
  }

  async function fillGreenhouseSecurityCode(code) {
    const value = String(code || "")
      .trim()
      .replace(/\s+/g, "");
    if (!value) return { ok: false, error: "Empty security code" };
    suppressLearn(4000);

    const boxes = findGreenhouseSecurityCodeBoxes();
    if (boxes.length >= 4) {
      const chars = value.slice(0, boxes.length).split("");
      for (let i = 0; i < boxes.length; i += 1) {
        const ch = chars[i] || "";
        const el = boxes[i];
        el.focus();
        if (!setNativeValue(el, ch)) {
          el.value = ch;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        el.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            key: ch,
            code: ch ? `Key${ch.toUpperCase()}` : "Backspace"
          })
        );
        await sleep(40);
      }
      const joined = boxes.map((el) => String(el.value || "").slice(0, 1)).join("");
      if (joined.toLowerCase() !== value.slice(0, boxes.length).toLowerCase()) {
        const first = boxes[0];
        first.focus();
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", value);
          first.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: dt }));
          await sleep(120);
        } catch {
          /* ignore */
        }
      }
      const after = boxes.map((el) => String(el.value || "").slice(0, 1)).join("");
      if (!after || after.replace(/\s/g, "").length < Math.min(4, value.length)) {
        return { ok: false, error: "Could not fill multi-box security code fields" };
      }
    } else {
      const el = findGreenhouseSecurityCodeInput();
      if (!el) return { ok: false, error: "Security code field not found" };
      const filled = await fillControl(el, value, null);
      if (!filled) return { ok: false, error: "Could not fill security code field" };
    }

    await sleep(200);
    const action = findActionButton();
    if (
      action?.el &&
      (action.type === "submit" || /submit|resubmit|verify|continue/i.test(action.text || ""))
    ) {
      scrollElIntoView(action.el);
      await clickKeepingSameTab(action.el, { preferNewTab: false });
      await sleep(900);
      return { ok: true, filled: true, submitted: true, text: action.text || "Submit" };
    }
    return { ok: true, filled: true, submitted: false };
  }

  function detectGreenhouseApplySuccess() {
    if (!isGreenhousePage()) return "";
    const bodyText = cleanLabelText(document.body?.innerText || document.body?.textContent || "");
    const headings = queryAllDeep("h1, h2, [role='heading']")
      .map((el) => cleanLabelText(el.textContent))
      .filter(Boolean);
    const headingHit = headings.find((t) => GREENHOUSE_APPLY_SUCCESS_RE.test(t));
    const bodyHit = bodyText ? bodyText.match(GREENHOUSE_APPLY_SUCCESS_RE) : null;
    const myGh = /mygreenhouse|track your application/i.test(bodyText);
    if (!headingHit && !bodyHit && !myGh) return "";
    if (detectGreenhouseEmailVerification().ok) return "";
    return (headingHit || (bodyHit && bodyHit[0]) || "Your application has been received").slice(0, 160);
  }

  function detectApplicationSuccess() {
    if (isGreenhousePage()) return detectGreenhouseApplySuccess();
    if (isWorkdayPage()) return detectWorkdayApplySuccess();
    if (isIndeedPage()) return detectIndeedApplySuccess();
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
    /\b(cancel|close|dismiss|skip|not now|maybe later|show ad|show ads|advert|sponsored|cookie|subscribe|sign in|log in|register|learn more|see more|next job|previous job|watch|play video|explore|get in touch|talk with|contact us|about us|corporate|governance|investors?|privacy|terms|sustainability|media hub|company overview|news(room)?|press|suppliers?|human rights|public policy)\b/i;
  const EASY_APPLY_TEXT_RE =
    /^\s*(easy\s*apply|1-?click apply|one-?click apply|quick apply)\s*$/i;
  /** ZipRecruiter labels that submit immediately with the saved resume — never auto-click. */
  const ZIPRECRUITER_ONE_CLICK_RE =
    /^\s*(1-?click\s*apply|one-?click\s*apply|quick\s*apply|easy\s*apply)\s*$/i;
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

  function clearActionHighlight() {
    document.getElementById("resume-bot-action-highlight")?.remove();
  }

  /** Outline the control the user should click next (Apply / Next / Submit). */
  function highlightActionElement(el) {
    clearActionHighlight();
    if (!el || !el.getBoundingClientRect) return;
    scrollElIntoView(el);
    const box = document.createElement("div");
    box.id = "resume-bot-action-highlight";
    const place = () => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) {
        box.remove();
        return;
      }
      box.style.cssText = [
        "position:fixed",
        `top:${Math.max(0, r.top - 4)}px`,
        `left:${Math.max(0, r.left - 4)}px`,
        `width:${r.width + 8}px`,
        `height:${r.height + 8}px`,
        "border:3px solid #e11d48",
        "border-radius:8px",
        "box-shadow:0 0 0 4px rgba(225,29,72,0.25)",
        "pointer-events:none",
        "z-index:2147483646",
        "transition:top 0.15s,left 0.15s,width 0.15s,height 0.15s"
      ].join(";");
    };
    place();
    document.documentElement.appendChild(box);
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    setTimeout(() => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      box.remove();
    }, 20000);
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

  function isDiceWizardFooterButton(btn) {
    if (!btn || typeof btn.closest !== "function") return false;
    return Boolean(
      btn.closest(
        [
          '[class*="footer"]',
          '[class*="Footer"]',
          '[data-testid*="footer"]',
          '[class*="wizard-action"]',
          '[class*="step-action"]',
          '[class*="form-action"]',
          '[class*="sticky"]',
          '[class*="WizardFooter"]',
          '[class*="wizard-footer"]',
          '[class*="actions"]'
        ].join(", ")
      )
    );
  }

  /** Job carousel / similar jobs chrome — not the application wizard footer. */
  function isDiceJobCarouselControl(btn) {
    if (!btn || !isDiceApplicationPath() || typeof btn.closest !== "function") return false;
    if (isDiceWizardFooterButton(btn)) return false;
    return Boolean(
      btn.closest(
        [
          '[class*="carousel"]',
          '[class*="Carousel"]',
          '[class*="job-card"]',
          '[class*="JobCard"]',
          '[class*="similar-jobs"]',
          '[class*="SimilarJobs"]',
          '[class*="job-list"]',
          '[class*="JobList"]',
          '[data-testid*="job-card"]',
          '[data-testid*="carousel"]',
          '[class*="job-view"]',
          '[class*="JobView"]',
          "aside"
        ].join(", ")
      )
    );
  }

  function findDiceWizardSubmitButton() {
    if (!isDiceApplicationPath()) return null;
    const root = getDiceWizardRoot() || document;
    const buttons = [
      ...root.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"]'
      )
    ].filter((el) => isElVisible(el) && !isSiteChromeControl(el) && !isDiceJobCarouselControl(el));

    for (const btn of buttons) {
      const text = elActionText(btn);
      const typeAttr = String(btn.getAttribute("type") || btn.type || "").toLowerCase();
      const hint = `${btn.getAttribute("data-testid") || ""} ${btn.id || ""} ${btn.className || ""}`;
      const isSubmit =
        classifyActionButton(text) === "submit" ||
        typeAttr === "submit" ||
        /^\s*(submit|apply(\s+now)?)\s*$/i.test(text) ||
        /submit/i.test(hint);
      if (!isSubmit || ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(btn)) continue;
      if (!isDiceWizardFooterButton(btn) && !/submit|apply/i.test(hint)) continue;
      return {
        type: "submit",
        el: btn,
        text: text || "Submit",
        disabled: !isElEnabled(btn),
        score: actionButtonScore(btn, "submit")
      };
    }
    return null;
  }

  /** Dice final wizard step: review + Submit (carousel Next must not win). */
  function detectDiceSubmitReviewPage() {
    if (!isDiceApplicationPath()) return false;
    if (detectApplicationSuccess()) return false;

    const path = String(location.pathname || "");
    if (/\/review(?:\/|$|\?)/i.test(path)) return true;

    const root = getDiceWizardRoot() || document;
    const heading = cleanLabelText(
      root.querySelector('h1, h2, h3, [role="heading"], legend')?.textContent || ""
    );
    if (/\breview\b/i.test(heading)) return true;

    const blob = cleanLabelText(root.innerText || "").slice(0, 8000).toLowerCase();
    if (
      /review your application|submit your application|ready to submit|confirm your application/.test(
        blob
      )
    ) {
      return true;
    }

    return Boolean(findDiceWizardSubmitButton());
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
      '[role="dialog"], dialog[open], dialog, [aria-modal="true"], .modal, [class*="modal"], [class*="apply"], [id*="apply"], [data-testid*="ApplyForm"], [class*="ia-ApplyForm"], [class*="ia-BasePage"]';
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

  /** Jobright job detail: the CTA has flipped to "Applied" / an applied badge is shown. */
  function detectJobrightAlreadyApplied() {
    if (!isJobrightPage()) return "";
    for (const el of document.querySelectorAll(
      "button, a, [role='button'], span, div"
    )) {
      if (!isElVisible(el)) continue;
      if (isSiteChromeControl(el) || isInsideAdOrOverlay(el)) continue;
      const text = elActionText(el);
      if (!text) continue;
      if (ALREADY_APPLIED_TEXT_RE.test(text) || /^\s*application submitted\s*$/i.test(text)) {
        return "Already applied on Jobright (marked Applied).";
      }
    }
    return "";
  }

  /** ZipRecruiter job detail: CTA already shows Applied. */
  function detectZipRecruiterAlreadyApplied() {
    if (!isZipRecruiterPage()) return "";
    for (const el of visibleActionControls()) {
      const text = elActionText(el);
      if (ALREADY_APPLIED_TEXT_RE.test(text) || /^\s*application submitted\s*$/i.test(text)) {
        return "Already applied on ZipRecruiter (marked Applied).";
      }
    }
    const body = cleanLabelText(document.body?.innerText || "").slice(0, 2000);
    if (/\byou(?:'|’)ve already applied\b|\balready applied\b/i.test(body)) {
      return "Already applied on ZipRecruiter.";
    }
    return "";
  }

  /**
   * True when the only ZipRecruiter apply CTA is 1-Click / Quick Apply
   * (instant submit with saved resume) — never auto-click those.
   */
  function detectZipRecruiterOneClickOnly() {
    if (!isZipRecruiterPage()) return "";
    try {
      if (/\/apply\b|\/application\b/i.test(location.pathname || "")) return "";
    } catch {
      /* ignore */
    }
    const controls = visibleActionControls();
    let sawOneClick = false;
    let sawSafeApply = false;
    for (const el of controls) {
      const text = elActionText(el);
      const hint = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""}`;
      if (ENTRY_JUNK_RE.test(text) || !text || text.length > 48) continue;
      if (ZIPRECRUITER_ONE_CLICK_RE.test(text) || ZIPRECRUITER_ONE_CLICK_RE.test(hint)) {
        sawOneClick = true;
        continue;
      }
      if (
        APPLY_NOW_RE.test(text) ||
        APPLY_ONLY_TEXT_RE.test(text) ||
        /^\s*(continue(\s+to)?\s*apply|start\s+application|apply\s+with\s+ziprecruiter)\s*$/i.test(
          text
        )
      ) {
        sawSafeApply = true;
      }
    }
    if (sawOneClick && !sawSafeApply) {
      return "ZipRecruiter 1-Click / Quick Apply would submit immediately — stopped before clicking.";
    }
    return "";
  }

  const IM_INTERESTED_RE = /^\s*i(?:['’]| a)?m interested\s*$/i;
  const APPLY_NOW_RE = /^\s*apply\s*now\s*$/i;
  const JOBGETHER_APPLY_RE = /^\s*apply\s*$/i;
  const JOBGETHER_AUTO_APPLY_RE = /^\s*auto\s*apply\s*$/i;
  // Jobright chrome that must never be treated as the apply CTA.
  const JOBRIGHT_JUNK_RE =
    /\b(ask\s*orion|orion|autofill|auto\s*fill|save|saved|not\s*interested|ask\s*ai|copilot|refer|share)\b/i;

  function visibleActionControls(root = document) {
    return queryAllDeep(
      "a, button, [role='button'], input[type='button'], input[type='submit']",
      root
    ).filter((el) => isElVisible(el) && isElEnabled(el) && !isSiteChromeControl(el));
  }

  const INTERRUPT_MODAL_TEXT_RE =
    /waiting can cost you|turns applications into interviews|reaching the hiring team|did you submit your application|i applied,\s*contact hiring manager|i didn't actually apply|i did not actually apply|i['’]ll engage later|no thanks,?\s*exit|we use cookies|cookie (policy|preferences|consent)|this (site|website) uses cookies|subscribe to (our )?(newsletter|updates)|create a free account to|unlock (premium|faster)|boost your (application|chances)/i;
  const DISMISS_MODAL_CTA_RE =
    /no thanks,?\s*exit|no thanks|no,? exit|not now|maybe later|skip(?: for now)?|dismiss|i['’]ll engage later|i will engage later|i didn't actually apply|i did not actually apply|reject all|decline|continue without|close/i;
  const KEEP_MODAL_OPEN_CTA_RE =
    /ok,? let['’]?s do it|let['’]?s do it now|contact hiring|i applied|subscribe|sign up|upgrade|boost|unlock|continue to apply with/i;
  const COOKIE_COPY_RE =
    /we use cookies|this (site|website) uses cookies|cookie (policy|preferences|consent|notice|banner)|accept cookies|allow cookies|manage cookies|cookie settings|gdpr|privacy (preferences|choices)|consent to (the use of )?cookies/i;
  /** Exact / near-exact cookie accept CTAs (button label alone). */
  const COOKIE_ACCEPT_TEXT_RE =
    /^\s*(accept all( cookies)?|allow all( cookies)?|allow cookies|yes,? allow( all)?( cookies)?|i agree|agree( and close)?|agree( and )?continue|accept( and close)?|accept( and )?continue|accept cookies|i accept|got it|ok(ay)?(,?\s*got it)?|allow|consent|confirm)\s*$/i;
  /** Looser match when the control sits inside a cookie banner. */
  const COOKIE_ACCEPT_LOOSE_RE =
    /\b(allow|accept)\b.{0,24}\b(all|cookies?|consent)\b|\b(i agree|agree and continue|accept and continue|got it)\b/i;
  const COOKIE_REJECT_TEXT_RE =
    /reject all|decline all|necessary only|essential only|reject|deny|continue without|manage (preferences|cookies)|cookie settings|customize|customise|set preferences/i;
  const COOKIE_BANNER_SEL = [
    "#onetrust-banner-sdk",
    "#onetrust-consent-sdk",
    "#CybotCookiebotDialog",
    "#usercentrics-root",
    "#didomi-host",
    "#didomi-notice",
    "#qc-cmp2-container",
    ".qc-cmp2-container",
    ".fc-consent-root",
    "#truste-consent-track",
    "#osano-cm-window",
    ".osano-cm-window",
    "#cc-main",
    ".cc-window",
    ".cc-banner",
    "#cookie-banner",
    "#cookieBanner",
    "#cookie-notice",
    "#cookieNotice",
    "[id*='cookie-banner']",
    "[class*='cookie-banner']",
    "[id*='cookieConsent']",
    "[class*='CookieConsent']",
    "[id*='cookie-consent']",
    "[class*='cookie-consent']",
    "[id*='consent-banner']",
    "[class*='consent-banner']",
    "[aria-label*='cookie' i]",
    "[aria-label*='consent' i]"
  ].join(", ");
  const COOKIE_ACCEPT_SEL = [
    "#onetrust-accept-btn-handler",
    "#accept-recommended-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "#CybotCookiebotDialogBodyLevelButtonAccept",
    "#didomi-notice-agree-button",
    ".fc-cta-consent",
    "button.fc-cta-consent",
    ".osano-cm-accept-all",
    "button.osano-cm-accept",
    "[data-testid='accept-cookies']",
    "[data-testid='cookie-accept']",
    "[data-testid*='uc-accept' i]",
    "[data-action='accept-all']",
    "button[aria-label*='accept all' i]",
    "button[aria-label*='allow all' i]",
    "button[aria-label*='accept cookies' i]",
    "button[aria-label*='allow cookies' i]",
    "button[id*='accept-all' i]",
    "button[id*='acceptAll' i]",
    "button[id*='allow' i][id*='cookie' i]",
    "button[class*='accept-all' i]",
    "button[class*='acceptAll' i]",
    "button[class*='allowAll' i]",
    "button[class*='allow-all' i]"
  ].join(", ");

  function modalRootSelector() {
    return '[role="dialog"], dialog[open], [aria-modal="true"], [class*="Modal"], [class*="modal"], [class*="popup"], [class*="Popup"], [class*="overlay"], [class*="Overlay"]';
  }

  function modalCopy(node) {
    return String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isLikelyApplicationModal(node) {
    if (!node) return false;
    const fields = node.querySelectorAll(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]'
    ).length;
    const files = node.querySelectorAll?.('input[type="file"]')?.length || 0;
    if (fields >= 3 || files >= 1) return true;
    const text = modalCopy(node).slice(0, 2200);
    const hint = `${node.id || ""} ${node.className || ""} ${node.getAttribute?.("data-testid") || ""}`;
    if (
      /\b(easy.?apply|apply.?form|application.?form|jobs?-?application|job-applications|posting-?apply|ia-ApplyForm|ia-BasePage)\b/i.test(
        `${text} ${hint}`
      )
    ) {
      return true;
    }
    if (fields >= 1 && /work experience|education|cover letter|first name|phone|resume|submit application/i.test(text)) {
      return true;
    }
    return false;
  }

  function isCloseControl(el) {
    if (!el) return false;
    const t = elActionText(el);
    const hint = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""} ${el.id || ""} ${el.className || ""}`;
    if (/^[x×]$/i.test(t) || /^(close|dismiss)$/i.test(t)) return true;
    if (/close|dismiss|modal-close|btn-close|popup-close/i.test(hint) && t.length <= 12) return true;
    return false;
  }

  /**
   * Only "No thanks / Not now" style CTAs. Never return bare Close/X — clicking
   * those closes LinkedIn / Indeed / Greenhouse application modals mid-fill.
   */
  function findModalDismissControl(modal) {
    const clickable = queryAllDeep(
      "a, button, [role='button'], input[type='button'], input[type='submit'], [aria-label], [title]",
      modal
    ).filter((el) => isElVisible(el) && isElEnabled(el));
    return (
      clickable.find((el) => {
        const t = elActionText(el);
        if (!t || KEEP_MODAL_OPEN_CTA_RE.test(t)) return false;
        if (isCloseControl(el) && !DISMISS_MODAL_CTA_RE.test(t)) return false;
        return DISMISS_MODAL_CTA_RE.test(t);
      }) || null
    );
  }

  function isInterruptModal(node) {
    if (!node || !isElVisible(node) || isLikelyApplicationModal(node)) return false;
    try {
      const rect = node.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 80) return false;
    } catch {
      /* ignore */
    }
    const text = modalCopy(node).slice(0, 2500);
    if (INTERRUPT_MODAL_TEXT_RE.test(text)) return true;
    const dismiss = findModalDismissControl(node);
    if (!dismiss) return false;
    const t = elActionText(dismiss);
    if (!t || /^(close|dismiss|[x×])$/i.test(t)) return false;
    return DISMISS_MODAL_CTA_RE.test(t);
  }

  function findInterruptModals() {
    const seen = new Set();
    const out = [];
    for (const node of queryAllDeep(modalRootSelector())) {
      if (seen.has(node) || !isInterruptModal(node)) continue;
      seen.add(node);
      out.push(node);
    }
    return out;
  }

  function visibleBannerClickables(root) {
    return queryAllDeep(
      "a, button, [role='button'], input[type='button'], input[type='submit']",
      root
    ).filter((el) => isElVisible(el) && isElEnabled(el));
  }

  function cookieControlHint(el) {
    return `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""} ${el.id || ""} ${el.className || ""} ${el.getAttribute?.("data-testid") || ""}`;
  }

  function scoreCookieAcceptControl(el, { inBanner = false } = {}) {
    if (!el || !isElVisible(el) || !isElEnabled(el)) return -1;
    const t = elActionText(el);
    const hint = cookieControlHint(el);
    const blob = `${t} ${hint}`;
    if (COOKIE_REJECT_TEXT_RE.test(t) && !COOKIE_ACCEPT_TEXT_RE.test(t)) return -1;
    if (/manage (preferences|cookies)|cookie settings|customise|customize/i.test(t)) return -1;

    let score = 0;
    if (/allow\s+cookies/i.test(t)) score += 200;
    if (/accept\s+all(\s+cookies)?/i.test(t)) score += 190;
    if (/allow\s+all(\s+cookies)?/i.test(t)) score += 185;
    if (COOKIE_ACCEPT_TEXT_RE.test(t)) score += 160;
    if (COOKIE_ACCEPT_LOOSE_RE.test(t)) score += 120;
    if (/accept.?all|allow.?all|accept.?cookie|allow.?cookie|agree.?button/i.test(hint)) score += 140;
    if (inBanner && COOKIE_ACCEPT_LOOSE_RE.test(blob)) score += 80;
    if (inBanner && /^(ok|okay|got it|agree|accept|allow|consent|confirm)$/i.test(t.trim())) score += 70;
    // Prefer primary-looking CTAs over tiny text links.
    try {
      const r = el.getBoundingClientRect();
      if (r.width >= 72 && r.height >= 28) score += 20;
    } catch {
      /* ignore */
    }
    return score;
  }

  function findKnownCookieAcceptButton(root = document) {
    try {
      const scored = queryAllDeep(COOKIE_ACCEPT_SEL, root)
        .map((el) => {
          if (!isElVisible(el) || !isElEnabled(el)) return { el, score: -1 };
          const scoredText = scoreCookieAcceptControl(el, { inBanner: true });
          // Known CMP accept selectors count even when the label is empty/icon-only.
          return { el, score: Math.max(scoredText, 100) };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored[0]?.el || null;
    } catch {
      return null;
    }
  }

  /** Document-wide "Allow cookies" / "Accept all" even when the banner has no known root. */
  function findCookieAcceptByText(root = document, { inBanner = false } = {}) {
    const clickable = visibleBannerClickables(root);
    let best = null;
    let bestScore = 0;
    for (const el of clickable) {
      const score = scoreCookieAcceptControl(el, { inBanner });
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    // Outside a known banner, require a strong accept label so we don't
    // click random "Allow" / "OK" buttons on the page.
    if (!inBanner && bestScore < 120) return null;
    return best;
  }

  function pickCookieAction(root) {
    const known = findKnownCookieAcceptButton(root);
    if (known) return known;
    const byText = findCookieAcceptByText(root, { inBanner: true });
    if (byText) return byText;
    // Never click Close/X for cookies — that often denies consent or does nothing.
    // Prefer an explicit accept/allow CTA only.
    return null;
  }

  function findCookieBannerRoots() {
    const seen = new Set();
    const out = [];
    try {
      for (const node of queryAllDeep(COOKIE_BANNER_SEL)) {
        if (seen.has(node) || !isElVisible(node)) continue;
        seen.add(node);
        out.push(node);
      }
    } catch {
      /* selector mismatch on this document */
    }
    for (const node of queryAllDeep(modalRootSelector())) {
      if (seen.has(node) || !isElVisible(node) || isLikelyApplicationModal(node)) continue;
      if (!COOKIE_COPY_RE.test(modalCopy(node).slice(0, 1800))) continue;
      seen.add(node);
      out.push(node);
    }
    return out;
  }

  function dismissCookieConsentOnce() {
    const known = findKnownCookieAcceptButton(document);
    if (known) {
      safeClick(known);
      return true;
    }
    const byText = findCookieAcceptByText(document, { inBanner: false });
    if (byText) {
      safeClick(byText);
      return true;
    }
    for (const banner of findCookieBannerRoots()) {
      const el = pickCookieAction(banner);
      if (!el) continue;
      safeClick(el);
      return true;
    }
    return false;
  }

  function dismissBlockingModalsOnce({ cookiesOnly = false } = {}) {
    if (dismissCookieConsentOnce()) return true;
    if (cookiesOnly) return false;
    // Once an application form/modal is open, never click dismiss/close —
    // that was shutting LinkedIn / Indeed Easy Apply mid-fill.
    try {
      if (probeApplicationForm().isApplicationForm) return false;
    } catch {
      /* probe may throw before install finishes */
    }
    let dismissed = false;
    for (const modal of findInterruptModals()) {
      if (isLikelyApplicationModal(modal)) continue;
      const el = findModalDismissControl(modal);
      if (!el) continue;
      safeClick(el);
      dismissed = true;
    }
    return dismissed;
  }

  async function dismissBlockingModals({ rounds = 4, cookiesOnly = false } = {}) {
    for (let i = 0; i < rounds; i += 1) {
      if (!dismissBlockingModalsOnce({ cookiesOnly })) break;
      await sleep(450);
    }
  }

  function findJobgetherApplyButton() {
    if (!isJobgetherPage()) return null;
    dismissBlockingModalsOnce();
    const controls = visibleActionControls();
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      if (JOBGETHER_AUTO_APPLY_RE.test(text)) continue;
      if (!JOBGETHER_APPLY_RE.test(text) && !APPLY_NOW_RE.test(text)) continue;
      if (ENTRY_JUNK_RE.test(text)) continue;
      let score = JOBGETHER_APPLY_RE.test(text) ? 100 : 80;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.top < 220 && rect.left > window.innerWidth * 0.45) score += 40;
        if (rect.width >= 72 && rect.height >= 28) score += 20;
      } catch {
        /* ignore */
      }
      scored.push({ type: "entry", el, text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  /** True when the Built In job page offers Easy Apply (prefer it over external Apply). */
  function builtInPageOffersEasyApply() {
    if (!isBuiltInPage()) return false;
    const controls = visibleActionControls();
    return controls.some((el) => {
      const text = elActionText(el);
      const hint = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""}`;
      return EASY_APPLY_TEXT_RE.test(text) || /\beasy\s*apply\b/i.test(hint);
    });
  }

  /**
   * Built In job detail: prefer "Easy Apply" on-site; otherwise "Apply" / "Apply Now"
   * which may hand off to an employer ATS.
   */
  function findBuiltInApplyButton() {
    if (!isBuiltInPage()) return null;
    dismissBlockingModalsOnce();
    const controls = visibleActionControls();
    const preferEasy = builtInPageOffersEasyApply();
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      const hint = `${el.getAttribute?.("title") || ""} ${el.getAttribute?.("aria-label") || ""} ${el.id || ""} ${el.className || ""}`;
      if (ENTRY_JUNK_RE.test(text)) continue;
      const isEasy = EASY_APPLY_TEXT_RE.test(text) || /\beasy\s*apply\b/i.test(hint);
      const isApplyNow = APPLY_NOW_RE.test(text) || APPLY_NOW_RE.test(hint);
      const isApply = APPLY_ONLY_TEXT_RE.test(text);
      if (preferEasy && !isEasy) continue;
      if (!isEasy && !isApplyNow && !isApply) continue;
      let score = isEasy ? 150 : isApplyNow ? 110 : 80;
      if (/apply/i.test(hint)) score += 15;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 72 && rect.height >= 28) score += 20;
        if (rect.top < 260 && rect.left > window.innerWidth * 0.4) score += 30;
      } catch {
        /* ignore */
      }
      scored.push({ type: "entry", el, text: text || (isEasy ? "Easy Apply" : "Apply"), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  /**
   * ZipRecruiter job detail:
   * - Never return 1-Click / Quick Apply (instant submit).
   * - Prefer Apply Now / Continue / Apply for native form (Route B) or external (Route C).
   */
  function findZipRecruiterApplyButton() {
    if (!isZipRecruiterPage()) return null;
    dismissBlockingModalsOnce();
    const controls = visibleActionControls();
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      const hint = `${el.getAttribute?.("title") || ""} ${el.getAttribute?.("aria-label") || ""} ${el.id || ""} ${el.className || ""}`;
      if (!text || text.length > 48) continue;
      if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(el)) continue;
      if (ALREADY_APPLIED_TEXT_RE.test(text)) continue;
      // Route A — never treat instant-submit CTAs as clickable entry.
      if (ZIPRECRUITER_ONE_CLICK_RE.test(text) || ZIPRECRUITER_ONE_CLICK_RE.test(hint)) continue;

      const isApplyNow = APPLY_NOW_RE.test(text) || APPLY_NOW_RE.test(hint);
      const isContinue =
        /^\s*(continue(\s+to)?\s*apply|start\s+application|apply\s+with\s+ziprecruiter)\s*$/i.test(
          text
        );
      const isApply = APPLY_ONLY_TEXT_RE.test(text);
      if (!isApplyNow && !isContinue && !isApply) continue;

      let score = isApplyNow ? 120 : isContinue ? 110 : 80;
      if (/apply/i.test(hint)) score += 15;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 72 && rect.height >= 28) score += 20;
        if (rect.top < 280 && rect.left > window.innerWidth * 0.35) score += 30;
      } catch {
        /* ignore */
      }
      scored.push({ type: "entry", el, text: text || "Apply", score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  /** Jobright job detail: the "APPLY NOW" CTA that hands off to the employer ATS. */
  function findJobrightApplyButton() {
    if (!isJobrightPage()) return null;
    dismissBlockingModalsOnce();
    const controls = visibleActionControls();
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      const hint = `${el.getAttribute?.("title") || ""} ${el.getAttribute?.("aria-label") || ""} ${el.id || ""} ${el.className || ""}`;
      if (JOBRIGHT_JUNK_RE.test(text) || JOBRIGHT_JUNK_RE.test(hint)) continue;
      if (JOBGETHER_AUTO_APPLY_RE.test(text)) continue;
      const isApplyNow = APPLY_NOW_RE.test(text);
      const isApply = JOBGETHER_APPLY_RE.test(text) || /^\s*apply\s+externally\s*$/i.test(text);
      if (!isApplyNow && !isApply) continue;
      if (ENTRY_JUNK_RE.test(text)) continue;
      let score = isApplyNow ? 120 : 80;
      if (/apply/i.test(hint)) score += 20;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 72 && rect.height >= 28) score += 20;
      } catch {
        /* ignore */
      }
      scored.push({ type: "entry", el, text: text || "Apply Now", score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  function findImInterestedButton() {
    if (!isSmartRecruitersPage() && !isZohoRecruitPage()) return null;
    const controls = visibleActionControls();
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      if (!IM_INTERESTED_RE.test(text) && !/i['’]?m interested|i am interested/i.test(text)) continue;
      if (ENTRY_JUNK_RE.test(text)) continue;
      scored.push({ type: "entry", el, text: text || "I'm interested", score: 120 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  function findOracleApplyNowButton() {
    if (!isOracleCloudPage()) return null;
    const controls = visibleActionControls();
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      const hint = `${el.getAttribute?.("title") || ""} ${el.getAttribute?.("aria-label") || ""} ${el.id || ""} ${el.className || ""}`;
      if (JOBGETHER_AUTO_APPLY_RE.test(text)) continue;
      const isApplyNow = APPLY_NOW_RE.test(text) || APPLY_NOW_RE.test(hint);
      const isApply = JOBGETHER_APPLY_RE.test(text);
      if (!isApplyNow && !isApply) continue;
      if (ENTRY_JUNK_RE.test(text)) continue;
      let score = isApplyNow ? 130 : 70;
      if (/apply/i.test(hint)) score += 20;
      scored.push({ type: "entry", el, text: text || "Apply Now", score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  /** Dice search/detail: the teal Apply button in the job detail panel (top-right). */
  function findDiceJobDetailApplyButton() {
    if (!/(^|\.)dice\.com$/i.test(location.hostname)) return null;
    if (isDiceApplicationPath()) return null;

    // Prefer explicit Dice apply markers before generic text matching.
    const marked = [];
    for (const sel of [
      '[data-cy*="apply"]',
      '[data-cy*="Apply"]',
      '[data-testid*="apply"]',
      '[data-testid*="Apply"]',
      '[data-test*="apply"]',
      'button[aria-label*="pply"]',
      'a[aria-label*="pply"]'
    ]) {
      try {
        marked.push(...document.querySelectorAll(sel));
      } catch {
        /* ignore invalid selector */
      }
    }

    const controls = [
      ...marked,
      ...document.querySelectorAll("button, a, [role='button']")
    ].filter((el) => isElVisible(el) && isElEnabled(el) && !isSiteChromeControl(el));
    const seen = new Set();
    const scored = [];
    for (const el of controls) {
      if (seen.has(el)) continue;
      seen.add(el);
      const text = elActionText(el);
      if (ALREADY_APPLIED_TEXT_RE.test(text)) continue;
      const hint = `${el.getAttribute("data-testid") || ""} ${el.getAttribute("data-cy") || ""} ${el.id || ""} ${el.className || ""} ${el.getAttribute("aria-label") || ""}`;
      const looksApply =
        APPLY_ONLY_TEXT_RE.test(text) ||
        EASY_APPLY_TEXT_RE.test(text) ||
        /easy[-_ ]?apply|apply[-_ ]?button|jobPostingApplyButton/i.test(hint);
      if (!looksApply) continue;
      if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(el)) continue;
      const href = String(el.href || el.getAttribute?.("href") || "");
      if (/\/profile\b/i.test(href)) continue;

      let score = EASY_APPLY_TEXT_RE.test(text) ? 120 : 90;
      if (/easy[-_ ]?apply|apply-button|job-detail|jobDetail|jobPostingApply/i.test(hint)) score += 40;
      if (/data-cy|data-testid/i.test(hint) && /apply/i.test(hint)) score += 35;

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
          '[data-testid*="job-detail" i], [class*="job-detail"], [class*="JobDetail"], [class*="search-detail"], [class*="details-pane"], [class*="job-view"], [class*="@container/job-detail"]'
        )
      ) {
        score += 60;
      }

      scored.push({ type: "entry", el, text: text || "Apply", score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  /**
   * After Dice Submit: click Close / Done on the success wizard when present.
   * Closing the tab is handled by the service worker.
   */
  async function dismissDiceSuccessWizard() {
    if (!/(^|\.)dice\.com$/i.test(location.hostname)) {
      return { ok: false, dismissed: false };
    }
    const success =
      detectApplicationSuccess() ||
      /\/wizard\/success(?:\/|$)/i.test(location.pathname) ||
      /\/job-applications\/[^/]+\/(?:wizard\/)?success\b/i.test(location.pathname);
    if (!success) return { ok: true, dismissed: false, reason: "not-success" };

    const closeRe =
      /^\s*(close|done|ok|got it|finish|return to (jobs|search|dice)|back to (jobs|search)|view (my )?applications?|continue browsing)\s*$/i;
    const root =
      document.querySelector(
        '[role="dialog"], [aria-modal="true"], [class*="success" i], [data-testid*="success" i], main, body'
      ) || document.body;
    const buttons = [
      ...root.querySelectorAll('button, a, [role="button"], input[type="button"]')
    ].filter((el) => isElVisible(el) && !isSiteChromeControl(el));

    for (const btn of buttons) {
      const text = elActionText(btn);
      if (!closeRe.test(text)) continue;
      scrollElIntoView(btn);
      try {
        btn.click();
      } catch {
        /* ignore */
      }
      await sleep(400);
      return { ok: true, dismissed: true, text: text || "Close" };
    }

    // Icon-only close (X) inside a success dialog.
    for (const btn of buttons) {
      const aria = String(btn.getAttribute("aria-label") || "").trim();
      if (!/^\s*(close|dismiss)\s*$/i.test(aria)) continue;
      if (!btn.closest('[role="dialog"], [aria-modal="true"], [class*="success" i]')) continue;
      try {
        btn.click();
      } catch {
        /* ignore */
      }
      await sleep(400);
      return { ok: true, dismissed: true, text: aria || "Close" };
    }

    return { ok: true, dismissed: false };
  }

  function findEasyApplyEntryButton() {
    dismissBlockingModalsOnce();
    const zipRecruiterApply = findZipRecruiterApplyButton();
    if (zipRecruiterApply) return zipRecruiterApply;
    // Route A: only 1-Click exists — do not fall through to generic Easy Apply matcher.
    if (isZipRecruiterPage()) return null;
    const builtinApply = findBuiltInApplyButton();
    if (builtinApply) return builtinApply;
    const jobrightApply = findJobrightApplyButton();
    if (jobrightApply) return jobrightApply;
    const jobgetherApply = findJobgetherApplyButton();
    if (jobgetherApply) return jobgetherApply;
    const interested = findImInterestedButton();
    if (interested) return interested;
    const oracleApply = findOracleApplyNowButton();
    if (oracleApply) return oracleApply;

    const diceDetail = findDiceJobDetailApplyButton();
    if (diceDetail) return diceDetail;

    const controls = [...document.querySelectorAll("button, a, [role='button']")].filter(
      (el) => isElVisible(el) && isElEnabled(el) && !isSiteChromeControl(el)
    );
    const scored = [];
    for (const el of controls) {
      const text = elActionText(el);
      if (!text || text.length > 48) continue;
      if (JOBGETHER_AUTO_APPLY_RE.test(text)) continue;
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
    const diceSubmitPage = isDiceApplicationPath() && detectDiceSubmitReviewPage();
    if (diceSubmitPage) {
      const submitOnly = findDiceWizardSubmitButton();
      if (submitOnly) return submitOnly;
    }

    const allButtons = [
      ...scopeEl.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"], [data-automation-id*="next"], [data-automation-id*="Next"], [data-automation-id*="submit"], [data-automation-id*="Submit"]'
      )
    ].filter((el) => isElVisible(el) && !isSiteChromeControl(el));
    const buttons = allButtons.filter((el) => isElEnabled(el));

    const candidates = { next: [], review: [], submit: [] };
    for (const btn of buttons) {
      const text = elActionText(btn);
      const typeAttr = String(btn.getAttribute("type") || btn.type || "").toLowerCase();
      const hint = `${btn.getAttribute("data-testid") || ""} ${btn.id || ""} ${btn.className || ""}`;
      if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(btn)) continue;
      if (isDiceApplicationPath() && isDiceJobCarouselControl(btn)) continue;
      if (EASY_BACK_RE.test(text) && !EASY_NEXT_RE.test(text) && !EASY_SUBMIT_RE.test(text)) {
        continue;
      }
      // Ignore job-carousel / listing "Next" while inside the application wizard.
      if (isDiceApplicationPath() && /\b(next job|previous job|next posting)\b/i.test(text)) {
        continue;
      }
      const autoCls = workdayAutomationAction(btn);
      const cls = autoCls || classifyActionButton(text);
      if (cls && candidates[cls]) {
        candidates[cls].push({ type: cls, el: btn, text, score: actionButtonScore(btn, cls) });
      } else if (
        (typeAttr === "submit" || /submit/i.test(hint) || autoCls === "submit") &&
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
        if (isDiceApplicationPath() && isDiceJobCarouselControl(btn)) continue;
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

    // Workday Review (including short My-Info → Review flows): prefer Submit.
    const wd = isWorkdayPage() ? detectWorkdayWizardState() : null;
    if (wd?.isReview) {
      if (submit) return submit;
    }

    // Dice wizard chrome often still has a "Next" (job carousel). The last
    // application step is Submit — always prefer it when it is on the wizard.
    if (isDiceApplicationPath()) {
      if (submit) return submit;
      if (diceSubmitPage) {
        const forced = findDiceWizardSubmitButton();
        if (forced) return forced;
      }
      if (next && !diceSubmitPage) return next;
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

  /**
   * Marketing / about / corporate destinations must never be followed during Apply.
   * Example: halliburton.com/.../corporate-profile/...
   */
  function isMarketingOrCorporateHref(href) {
    const raw = String(href || "").trim();
    if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return false;
    try {
      const u = new URL(raw, location.href);
      const blob = `${u.hostname}${u.pathname}${u.search}`.toLowerCase();
      return /about-us|about\/|corporate-profile|corporate-governance|board-of-directors|code-of-business|investor|investors\b|\/privacy\b|\/terms\b|media-hub|press-release|sustainability|human-rights|public-policy|contact-us|talk-with|get-in-touch|\/news\b|\/community\b|suppliers\b/i.test(
        blob
      );
    } catch {
      return /about-us|corporate-profile|corporate-governance|investor|privacy|sustainability/i.test(raw);
    }
  }

  /** True when an href looks like an application / careers apply destination. */
  function isApplyRelatedHref(href) {
    const raw = String(href || "").trim();
    if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return true;
    if (isMarketingOrCorporateHref(raw)) return false;
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.toLowerCase();
      const path = `${u.pathname || ""}${u.search || ""}`;
      if (host === location.hostname.toLowerCase()) {
        // Same-host hash/query moves and in-app steps are fine; block marketing paths.
        if (isMarketingOrCorporateHref(u.href)) return false;
        return true;
      }
      if (/(^|\.)(greenhouse\.io|myworkdayjobs\.com|workdayjobs\.com|smartrecruiters\.com|oraclecloud\.com|zohorecruit\.com|indeed\.com|dice\.com|ziprecruiter\.com)$/i.test(host)) {
        return true;
      }
      return /\/(apply|application|job-applications|job|jobs|career|careers|position|requisition)\b/i.test(path);
    } catch {
      return false;
    }
  }

  /** Apply / Next / Continue / Submit / Review style labels only. */
  function isApplicationActionText(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 80) return false;
    if (ENTRY_JUNK_RE.test(t)) return false;
    if (classifyActionButton(t)) return true;
    if (EASY_ENTRY_RE.test(t) || EASY_APPLY_TEXT_RE.test(t) || APPLY_ONLY_TEXT_RE.test(t)) return true;
    if (/^\s*(i['’]?m interested|i am interested|start application|begin application|apply for this job|apply manually|apply externally)\s*$/i.test(t)) {
      return true;
    }
    return false;
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
        if (/^https?:/i.test(href)) {
          if (isMarketingOrCorporateHref(href) || !isApplyRelatedHref(href)) {
            return {
              clicked: false,
              navigateUrl: "",
              openInNewTab: false,
              refused: true,
              error: "Refused non-apply link."
            };
          }
          try {
            const dest = new URL(href);
            const here = new URL(location.href);
            const leavesPage =
              dest.origin !== here.origin ||
              dest.pathname.replace(/\/$/, "") !== here.pathname.replace(/\/$/, "");
            // Never blind-click cross-page links — return the URL for the SW to validate.
            if (leavesPage || preferNewTab || target === "_blank" || target === "blank") {
              return {
                clicked: false,
                navigateUrl: href,
                openInNewTab: Boolean(preferNewTab || target === "_blank" || target === "blank")
              };
            }
          } catch {
            return { clicked: false, navigateUrl: href, openInNewTab: Boolean(preferNewTab) };
          }
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
        if (isMarketingOrCorporateHref(capturedUrl) || !isApplyRelatedHref(capturedUrl)) {
          return {
            clicked: false,
            navigateUrl: "",
            openInNewTab: false,
            refused: true,
            error: "Refused non-apply popup URL."
          };
        }
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

  function workdayAutomationAction(el) {
    if (!(el instanceof Element)) return null;
    const autoId = String(el.getAttribute?.("data-automation-id") || "");
    if (!autoId) return null;
    if (/submit/i.test(autoId)) return "submit";
    if (/next|continue|saveAndContinue|bottom-navigation-next/i.test(autoId)) return "next";
    return null;
  }

  /**
   * Workday wizards vary by employer. Detect the progress/heading on screen.
   */
  function detectWorkdayWizardState() {
    if (!isWorkdayPage()) return null;

    const STEP_NAME_RE =
      /\b(my information|personal information|contact information|my experience|work experience|experience|education|application questions|questions|voluntary disclosures?|self[- ]?identify|review|account information|create account|sign in)\b/i;

    const normalizeStep = (raw) => {
      const t = cleanLabelText(raw || "");
      if (!t || t.length > 90) return "";
      const m = t.match(STEP_NAME_RE);
      if (!m) return "";
      const key = m[1].toLowerCase();
      if (/create account|sign in|account information/.test(key)) return "Account";
      if (/my information|personal information|contact information/.test(key)) return "My Information";
      if (/my experience|work experience|^experience$/.test(key)) return "My Experience";
      if (/^education$/.test(key)) return "Education";
      if (/application questions|^questions$/.test(key)) return "Application Questions";
      if (/voluntary/.test(key)) return "Voluntary Disclosures";
      if (/self/.test(key)) return "Self Identify";
      if (/review/.test(key)) return "Review";
      return m[1];
    };

    const steps = [];
    const seen = new Set();
    const pushStep = (label) => {
      const n = normalizeStep(label);
      if (!n || seen.has(n)) return;
      seen.add(n);
      steps.push(n);
    };

    for (const el of queryAllDeep(
      [
        '[data-automation-id*="progress"]',
        '[data-automation-id*="Progress"]',
        '[data-automation-id*="wizard"]',
        '[data-automation-id*="step"]',
        '[aria-current="step"]',
        '[aria-current="page"]',
        "nav li",
        '[role="listitem"]',
        '[role="navigation"] button',
        '[role="navigation"] a'
      ].join(", ")
    )) {
      if (!isElVisible(el) && el.getAttribute?.("aria-current") == null) continue;
      pushStep(el.textContent || el.getAttribute?.("aria-label") || "");
    }

    const headingEl =
      document.querySelector('[data-automation-id="pageHeaderTitleText"]') ||
      document.querySelector('[data-automation-id*="pageHeader"]') ||
      document.querySelector("h1, h2, [role='heading']");
    const heading = cleanLabelText(headingEl?.textContent || "");
    const headingStep = normalizeStep(heading);

    let current = "";
    const currentEl = queryAllDeep('[aria-current="step"], [aria-current="page"]').find((el) =>
      STEP_NAME_RE.test(el.textContent || el.getAttribute?.("aria-label") || "")
    );
    if (currentEl) current = normalizeStep(currentEl.textContent || currentEl.getAttribute("aria-label"));
    if (!current && headingStep) current = headingStep;
    if (!current) {
      const path = String(location.pathname || "");
      if (/\/review/i.test(path)) current = "Review";
      else if (/\/experience/i.test(path)) current = "My Experience";
      else if (/\/education/i.test(path)) current = "Education";
      else if (/\/questions?/i.test(path)) current = "Application Questions";
      else if (/\/voluntary/i.test(path)) current = "Voluntary Disclosures";
      else if (/\/self.?ident/i.test(path)) current = "Self Identify";
      else if (/\/(myInfo|my.?information|personal)/i.test(path)) current = "My Information";
    }
    if (headingStep && !seen.has(headingStep)) pushStep(headingStep);
    if (current && !seen.has(current)) pushStep(current);

    const isReview =
      current === "Review" || /review/i.test(heading) || /\/review(?:\/|$|\?)/i.test(location.pathname);
    const isAuth =
      current === "Account" ||
      /create account|sign in|log in|register/i.test(heading) ||
      (Boolean(
        document.querySelector(
          'input[type="password"], [data-automation-id*="password"], [name*="password" i]'
        )
      ) &&
        /create account|sign in|log in|register|account/i.test(
          document.body?.innerText?.slice(0, 2000) || ""
        ));

    return {
      current: current || headingStep || "",
      heading,
      steps,
      stepCount: steps.length || (current ? 1 : 0),
      isReview,
      isAuth,
      isExperience: current === "My Experience" || /experience/i.test(current || ""),
      isEducation: current === "Education",
      isMyInfo: current === "My Information",
      isSimpleFlow: steps.length > 0 && steps.length <= 4
    };
  }

  async function clickGreenhouseApplyEntry() {
    const controls = queryAllDeep(
      "a, button, [role='button'], input[type='button'], input[type='submit']"
    ).filter((el) => isElVisible(el) && isElEnabled(el));
    const applyBtn = controls.find((el) => {
      const t = elActionText(el).trim();
      return /^(apply|apply now|apply for this job)$/i.test(t);
    });
    if (applyBtn) {
      const res = await clickKeepingSameTab(applyBtn, { preferNewTab: false });
      await sleep(1200);
      return {
        ok: Boolean(res.clicked || res.navigateUrl),
        clicked: Boolean(res.clicked),
        navigateUrl: res.navigateUrl || "",
        openInNewTab: Boolean(res.openInNewTab),
        text: elActionText(applyBtn) || "Apply"
      };
    }
    if (probeApplicationForm().isApplicationForm || /job_app|\/apply/i.test(location.href)) {
      return { ok: true, clicked: false, alreadyOpen: true, text: "greenhouse apply" };
    }
    return { ok: false, clicked: false };
  }

  async function clickWorkdayApplyEntry() {
    const modalBtns = queryAllDeep("button, a, [role='button'], [data-automation-id]").filter(
      (el) => isElVisible(el) && isElEnabled(el)
    );
    const autofillResume = modalBtns.find((el) =>
      /autofill with resume|apply with resume|upload (a )?resume/i.test(elActionText(el))
    );
    if (autofillResume) {
      scrollElIntoView(autofillResume);
      safeClick(autofillResume);
      await sleep(1400);
      return { ok: true, clicked: true, text: elActionText(autofillResume) || "Autofill with Resume" };
    }

    const authCta = modalBtns.find((el) =>
      /^(create account|create an account|sign in|log in|register)$/i.test(elActionText(el).trim())
    );
    if (authCta) {
      scrollElIntoView(authCta);
      safeClick(authCta);
      await sleep(1200);
      return { ok: true, clicked: true, text: elActionText(authCta) };
    }

    const applyBtn = modalBtns.find((el) => {
      const t = elActionText(el);
      const autoId = String(el.getAttribute?.("data-automation-id") || "");
      return (
        /^(apply|apply now)$/i.test(t.trim()) || /jobPostingApplyButton|applyButton/i.test(autoId)
      );
    });
    if (applyBtn) {
      scrollElIntoView(applyBtn);
      safeClick(applyBtn);
      await sleep(1400);
      const after = queryAllDeep("button, a, [role='button']").filter(
        (el) => isElVisible(el) && isElEnabled(el)
      );
      const resumeOpt = after.find((el) =>
        /autofill with resume|apply with resume/i.test(elActionText(el))
      );
      if (resumeOpt) {
        scrollElIntoView(resumeOpt);
        safeClick(resumeOpt);
        await sleep(1400);
        return { ok: true, clicked: true, text: elActionText(resumeOpt) || "Autofill with Resume" };
      }
      return { ok: true, clicked: true, text: elActionText(applyBtn) || "Apply" };
    }

    if (/\/apply\//i.test(location.href) || probeApplicationForm().isApplicationForm) {
      return { ok: true, clicked: false, alreadyOpen: true, text: "workday apply" };
    }
    return { ok: false, clicked: false };
  }

  async function clickLabeledEntry(target, { preferNewTab = false, alreadyOpenText = "" } = {}) {
    if (!target?.el) {
      if (alreadyOpenText && probeApplicationForm().isApplicationForm) {
        return { ok: true, clicked: false, alreadyOpen: true, text: alreadyOpenText };
      }
      return { ok: false, clicked: false };
    }
    const res = await clickKeepingSameTab(target.el, { preferNewTab });
    await sleep(res.clicked ? 1000 : 400);
    return {
      ok: Boolean(res.clicked || res.navigateUrl),
      clicked: Boolean(res.clicked),
      navigateUrl: res.navigateUrl || "",
      openInNewTab: Boolean(res.openInNewTab || preferNewTab),
      text: target.text || elActionText(target.el)
    };
  }

  async function clickEasyApplyEntry({ preferNewTab = false } = {}) {
    await sleep(400);
    await dismissBlockingModals();
    if (isJobrightPage()) {
      const linkedinUrl = detectJobrightLinkedInApply();
      if (linkedinUrl) {
        return {
          ok: false,
          clicked: false,
          linkedinRedirect: linkedinUrl,
          externalUrl: linkedinUrl
        };
      }
      const target = findJobrightApplyButton();
      if (!target?.el) {
        return { ok: false, clicked: false, navigateUrl: "", openInNewTab: false };
      }
      const href =
        target.el.href ||
        target.el.getAttribute?.("href") ||
        target.el.getAttribute?.("formaction") ||
        "";
      if (href && isLinkedInApplyUrl(href)) {
        const absolute = new URL(href, location.href).toString();
        return {
          ok: false,
          clicked: false,
          linkedinRedirect: absolute,
          externalUrl: absolute
        };
      }
      // Gateway: open employer ATS in a new tab (Greenhouse / Workday / etc.).
      const res = await clickKeepingSameTab(target.el, { preferNewTab: true });
      await sleep(1200);
      if (res.navigateUrl && isLinkedInApplyUrl(res.navigateUrl)) {
        return {
          ok: false,
          clicked: Boolean(res.clicked),
          linkedinRedirect: res.navigateUrl,
          externalUrl: res.navigateUrl
        };
      }
      return {
        ok: Boolean(res.clicked || res.navigateUrl),
        clicked: Boolean(res.clicked),
        navigateUrl: res.navigateUrl || "",
        openInNewTab: Boolean(res.openInNewTab || true),
        text: target.text || elActionText(target.el) || "Apply Now"
      };
    }
    if (isZipRecruiterPage()) {
      const oneClick = detectZipRecruiterOneClickOnly();
      if (oneClick) {
        return { ok: false, clicked: false, oneClickApply: oneClick };
      }
      const target = findZipRecruiterApplyButton();
      if (!target?.el) {
        return { ok: false, clicked: false, navigateUrl: "", openInNewTab: false };
      }
      const href =
        target.el.href ||
        target.el.getAttribute?.("href") ||
        target.el.getAttribute?.("formaction") ||
        "";
      if (href && !isSameSiteApplyUrl(href, "ziprecruiter")) {
        return {
          ok: false,
          clicked: false,
          externalRedirect: true,
          externalUrl: new URL(href, location.href).toString()
        };
      }
      const res = await clickKeepingSameTab(target.el, { preferNewTab: false });
      await sleep(1200);
      // If Apply opened an off-site employer tab/window, treat as Route C.
      if (res.navigateUrl && !isSameSiteApplyUrl(res.navigateUrl, "ziprecruiter")) {
        return {
          ok: false,
          clicked: Boolean(res.clicked),
          externalRedirect: true,
          externalUrl: res.navigateUrl
        };
      }
      return {
        ok: Boolean(res.clicked || res.navigateUrl),
        clicked: Boolean(res.clicked),
        navigateUrl: res.navigateUrl || "",
        openInNewTab: Boolean(res.openInNewTab),
        text: target.text || elActionText(target.el) || "Apply"
      };
    }
    if (isBuiltInPage()) {
      const target = findBuiltInApplyButton();
      const easyApply = target && /\beasy\s*apply\b/i.test(target.text || "");
      return clickLabeledEntry(target, {
        preferNewTab: easyApply ? false : true,
        alreadyOpenText: easyApply ? "easy apply" : "apply"
      });
    }
    if (isJobgetherPage()) {
      return clickLabeledEntry(findJobgetherApplyButton(), {
        preferNewTab,
        alreadyOpenText: "jobgether apply"
      });
    }
    if (isSmartRecruitersPage() || isZohoRecruitPage()) {
      const hit = findImInterestedButton();
      if (hit) return clickLabeledEntry(hit, { preferNewTab: false, alreadyOpenText: "I'm interested" });
      if (probeApplicationForm().isApplicationForm) {
        return { ok: true, clicked: false, alreadyOpen: true, text: "application form" };
      }
    }
    if (isOracleCloudPage()) {
      const hit = findOracleApplyNowButton();
      if (hit) return clickLabeledEntry(hit, { preferNewTab: false, alreadyOpenText: "Apply Now" });
      if (probeApplicationForm().isApplicationForm || /\/apply\b/i.test(location.href)) {
        return { ok: true, clicked: false, alreadyOpen: true, text: "oracle apply" };
      }
    }
    if (isGreenhousePage()) {
      return clickGreenhouseApplyEntry();
    }
    if (isWorkdayPage()) {
      return clickWorkdayApplyEntry();
    }
    if (isIndeedPage()) {
      const controls = queryAllDeep("button, a, [role='button']").filter(
        (el) => isElVisible(el) && isElEnabled(el)
      );
      const indeedTarget = controls.find((el) => {
        const blob = [
          el.id,
          el.getAttribute?.("data-testid"),
          el.getAttribute?.("aria-label"),
          elActionText(el)
        ].join(" ");
        return /indeedApplyButton|apply now|easily apply|continue to apply|apply on indeed/i.test(
          blob
        );
      });
      if (indeedTarget) {
        const href = indeedTarget.href || indeedTarget.getAttribute?.("formaction") || "";
        if (href && !isSameSiteApplyUrl(href, "indeed")) {
          return {
            ok: false,
            clicked: false,
            externalRedirect: true,
            externalUrl: new URL(href, location.href).toString()
          };
        }
        const res = await clickKeepingSameTab(indeedTarget, { preferNewTab: false });
        await sleep(1200);
        return {
          ok: Boolean(res.clicked || res.navigateUrl),
          clicked: Boolean(res.clicked),
          navigateUrl: res.navigateUrl || "",
          openInNewTab: Boolean(res.openInNewTab),
          text: elActionText(indeedTarget) || "Apply now"
        };
      }
    }
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
    const wd = isWorkdayPage() ? detectWorkdayWizardState()?.current || "" : "";
    return `${location.href}|${wd}|${heading}|${fields}`;
  }

  /**
   * @param {{ requiredOnly?: boolean }} [opts] On a Submit/review step only fields
   *   the form marks required may hold the application back; elsewhere any blank
   *   field means there is still work to do.
   */
  function formNeedsFill({ requiredOnly = false } = {}) {
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
      // A read-only summary field on a review page can never be filled by us,
      // so it must not block Submit.
      if (requiredOnly && (!controlIsRequired(el) || !isFieldFillable(el))) continue;
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
    const emailVerification = detectGreenhouseEmailVerification();
    const workdayWizard = isWorkdayPage() ? detectWorkdayWizardState() : null;
    // Job listing / job-detail: only Easy Apply or Apply. Never ads, Cancel, Next job.
    if (!probe.isApplicationForm) {
      const alreadyApplied =
        probe.alreadyApplied ||
        detectDiceAlreadyApplied() ||
        detectJobrightAlreadyApplied() ||
        detectZipRecruiterAlreadyApplied();
      const oneClickApply = probe.oneClickApply || detectZipRecruiterOneClickOnly();
      const linkedinRedirect = probe.linkedinRedirect || detectJobrightLinkedInApply();
      const entry =
        alreadyApplied || oneClickApply || linkedinRedirect ? null : findEasyApplyEntryButton();
      return {
        ok: true,
        href: location.href,
        signature: stepSignature(),
        isApplicationForm: false,
        site: applyPageSite(),
        workdayWizard,
        emailVerification: Boolean(emailVerification.ok),
        emailVerificationText: emailVerification.text || "",
        blockedReason: probe.blockedReason || "",
        jobUnavailable: probe.jobUnavailable || "",
        alreadyApplied: alreadyApplied || "",
        oneClickApply: oneClickApply || "",
        linkedinRedirect: linkedinRedirect || "",
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
    const diceSubmitPage = isDiceApplicationPath() && detectDiceSubmitReviewPage();
    // A Submit button on the page does not mean the page is finished. Required
    // fields still waiting on an answer keep this true, so Apply fills them
    // before it submits; optional blanks are ignored so they cannot stall it.
    const needsFill =
      action?.type === "submit" || diceSubmitPage
        ? busy || formNeedsFill({ requiredOnly: true })
        : formNeedsFill() || busy;
    return {
      ok: true,
      href: location.href,
      signature: stepSignature(),
      isApplicationForm: Boolean(probe.isApplicationForm),
      site: applyPageSite(),
      workdayWizard,
      diceSubmitPage,
      emailVerification: Boolean(emailVerification.ok),
      emailVerificationText: emailVerification.text || "",
      fillableCount: Number(probe.fillableCount || 0),
      blockedReason: probe.blockedReason || "",
      jobUnavailable: probe.jobUnavailable || "",
      alreadyApplied: "",
      oneClickApply: "",
      linkedinRedirect: "",
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
        ok: Boolean(entryRes?.clicked || entryRes?.navigateUrl || entryRes?.alreadyOpen),
        clicked: Boolean(entryRes?.clicked),
        navigateUrl: entryRes?.navigateUrl || "",
        openInNewTab: Boolean(entryRes?.openInNewTab),
        isSubmit: false,
        externalRedirect: Boolean(entryRes?.externalRedirect),
        externalUrl: entryRes?.externalUrl || "",
        oneClickApply: entryRes?.oneClickApply || "",
        linkedinRedirect: entryRes?.linkedinRedirect || "",
        action:
          entryRes?.clicked || entryRes?.navigateUrl || entryRes?.alreadyOpen
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
      const dice = /(^|\.)dice\.com$/i.test(location.hostname);
      await waitForUploadsToSettle(dice ? 500 : 15000);
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
      // User clicked Submit in Ocean — only press Submit / Apply on the page.
      // Do not prefer Next/Continue when a final control is available.
      const findSubmitOnly = () => {
        const hit = findActionButton(null, { includeDisabledSubmit: true });
        if (hit?.type === "submit") return hit;
        const scopeEl = getApplyScope();
        const buttons = [
          ...scopeEl.querySelectorAll(
            'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
          )
        ].filter((el) => isElVisible(el) && !isSiteChromeControl(el));
        const scored = [];
        for (const btn of buttons) {
          const text = elActionText(btn);
          if (ENTRY_JUNK_RE.test(text) || isInsideAdOrOverlay(btn)) continue;
          const typeAttr = String(btn.getAttribute("type") || btn.type || "").toLowerCase();
          const hint = `${btn.getAttribute("data-testid") || ""} ${btn.id || ""} ${btn.className || ""}`;
          const isSubmit =
            classifyActionButton(text) === "submit" ||
            typeAttr === "submit" ||
            /^\s*(submit|apply(\s+now)?|send(\s+application)?)\s*$/i.test(text) ||
            /submit/i.test(hint);
          if (!isSubmit) continue;
          scored.push({
            type: "submit",
            el: btn,
            text: text || "Submit",
            score: actionButtonScore(btn, "submit") + (isElEnabled(btn) ? 20 : 0)
          });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored[0] || null;
      };
      for (let i = 0; i < 12; i += 1) {
        action = findSubmitOnly();
        if (action?.el && isElEnabled(action.el)) break;
        if (action?.el && i >= 2) break;
        await sleep(250);
      }
      if (action?.el && !isElEnabled(action.el)) {
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
    const linkHref = String(action.el?.href || action.el?.getAttribute?.("href") || "").trim();
    if (linkHref && (isMarketingOrCorporateHref(linkHref) || !isApplyRelatedHref(linkHref))) {
      return {
        ok: false,
        clicked: false,
        navigateUrl: "",
        openInNewTab: false,
        error: `Refused non-apply link "${elActionText(action.el)}"`,
        action: null,
        before,
        after: before
      };
    }
    const actionHref =
      action.el?.href ||
      action.el?.getAttribute?.("formaction") ||
      action.el?.closest?.("form")?.getAttribute?.("action") ||
      "";
    if (
      (isIndeedPage() || isZipRecruiterPage()) &&
      actionHref &&
      !isSameSiteApplyUrl(actionHref, isIndeedPage() ? "indeed" : "ziprecruiter") &&
      !isBuiltInPage()
    ) {
      return {
        ok: false,
        clicked: false,
        externalRedirect: true,
        externalUrl: new URL(actionHref, location.href).toString(),
        action: describeAction(action),
        before,
        after: before
      };
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
    await dismissBlockingModals();
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
      // Cookies only once the application form/modal is open — never close it.
      await dismissBlockingModals({
        rounds: 2,
        cookiesOnly: Boolean(probeApplicationForm().isApplicationForm)
      });
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
          if (isDiceApplicationPath()) await sleep(1000);
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

  // ---- Whole-form scan + AI form plan -----------------------------------------
  //
  // The AI planner has to see the form the way a person does: every field on
  // the step, what kind of widget it is, the exact choices a dropdown or radio
  // group offers, and whether the form requires it. The scan tags each field
  // with data-resume-bot-fid so the plan that comes back lands on the same
  // element, and tags the page's buttons (data-resume-bot-bid) so the AI can
  // name the one that moves the application forward when the rule-based finder
  // recognises none.

  /** Profile keys the rules still fill in plan mode: who and where the candidate is. */
  const PLAN_MODE_RULE_KEYS = new Set([
    "firstName",
    "lastName",
    "middleName",
    "preferredName",
    "email",
    "phone",
    "phoneCountryCode",
    "phoneDeviceType",
    "addressLine1",
    "addressLine2",
    "city",
    "state",
    "zipCode",
    "country",
    "cityCountryOfResidence",
    "linkedinUrl",
    "portfolioUrl",
    "githubUrl"
  ]);

  const SCAN_SKIP_RE =
    /\b(password|otp|one.?time (code|passcode)|captcha|verification code|security code|ssn|social security|credit card|card number|cvv|routing number|account number)\b/i;
  const MAX_SCAN_FIELDS = 80;
  const MAX_SCAN_OPTIONS = 400;
  const MAX_SCAN_COMBO_OPENS = 20;
  const MAX_SCAN_BUTTONS = 40;
  const SCAN_EDITOR_SELECTOR =
    '[contenteditable="true"], [contenteditable=""], [role="textbox"][aria-multiline="true"], .ql-editor, .ck-editor__editable, .fr-element, .public-DraftEditor-content, .ProseMirror';
  const SCAN_FIELD_SELECTOR = `input, textarea, select, [role="combobox"], [aria-haspopup="listbox"], ${SCAN_EDITOR_SELECTOR}`;
  const SECTION_HEADING_SELECTOR = "h1, h2, h3, h4, legend, [role='heading']";
  const SECTION_HEADING_CHILD_SELECTOR = SECTION_HEADING_SELECTOR.split(", ")
    .map((s) => `:scope > ${s}`)
    .join(", ");
  const REQUIRED_NOISE_RE =
    /\b(this field is required|required field|please (select|choose) an option|select an option)\b\.?/gi;
  const TEXT_INPUT_TYPES = new Set([
    "",
    "text",
    "email",
    "tel",
    "url",
    "number",
    "date",
    "month",
    "week",
    "time",
    "datetime-local"
  ]);
  const CHOICE_FIELD_KINDS = new Set(["select", "radio", "checkbox", "checkbox_group", "combobox"]);

  function labelElementFor(input) {
    if (input.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (byFor) return byFor;
      } catch {
        /* invalid id */
      }
    }
    return input.closest?.("label") || null;
  }

  /** Custom radio / checkbox designs hide the real input and show a styled label. */
  function isScanVisible(el) {
    try {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const shown =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        (rect.width > 0 || rect.height > 0);
      if (shown) return true;
      if (el.type === "radio" || el.type === "checkbox") {
        const label = labelElementFor(el);
        return Boolean(label && isElVisible(label));
      }
      return false;
    } catch {
      return false;
    }
  }

  function cleanScanLabel(text) {
    return cleanLabelText(String(text || "").replace(REQUIRED_NOISE_RE, " "));
  }

  /** The visible text of one radio / checkbox option. */
  function optionTextForMember(input, max = 200) {
    const label = labelElementFor(input);
    if (label) {
      const clone = label.cloneNode(true);
      clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
      const t = cleanLabelText(clone.textContent);
      if (t) return t.slice(0, max);
    }
    const aria = cleanLabelText(input.getAttribute("aria-label"));
    if (aria) return aria.slice(0, max);
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = cleanLabelText(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
      );
      if (t) return t.slice(0, max);
    }
    const next = input.nextElementSibling;
    if (next && /^(LABEL|SPAN|DIV|P)$/.test(next.tagName)) {
      const t = cleanLabelText(next.textContent);
      if (t && t.length <= max) return t;
    }
    const value = cleanLabelText(input.value || "");
    return value && value.toLowerCase() !== "on" ? value.slice(0, max) : "";
  }

  function choiceGroupMembers(el) {
    const type = el.type;
    if (el.name) {
      try {
        const same = [
          ...document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)
        ];
        if (same.length > 1) return same;
      } catch {
        /* invalid name */
      }
    }
    const container = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (container) {
      const inside = [...container.querySelectorAll(`input[type="${type}"]`)];
      if (inside.length > 1) return inside;
    }
    return [el];
  }

  /** Remove the last whole-word occurrence of `phrase` (option labels trail the question). */
  function removeLastPhrase(text, phrase) {
    const p = cleanLabelText(phrase);
    if (!p) return text;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, "g");
    let last = null;
    let m;
    while ((m = re.exec(text))) {
      last = m;
      if (!m[0].length) re.lastIndex += 1;
    }
    if (!last) return text;
    const start = last.index + last[1].length;
    return `${text.slice(0, start)} ${text.slice(start + p.length)}`;
  }

  /**
   * The question a radio / checkbox group answers. A radio's own <label> is its
   * option ("Yes"), so the question is the legend, the group's accessible name,
   * or the text of the closest wrapper around every option minus those options.
   */
  function groupQuestionText(members) {
    const first = members[0];
    const legend = first.closest("fieldset")?.querySelector(":scope > legend");
    const legendText = cleanLabelText(legend?.textContent || "");
    if (legendText) return legendText;

    const group = first.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      const labelledBy = group.getAttribute("aria-labelledby");
      if (labelledBy) {
        const t = cleanLabelText(
          labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ")
        );
        if (t) return t;
      }
      const aria = cleanLabelText(group.getAttribute("aria-label"));
      if (aria) return aria;
    }

    const optionTexts = members.map((m) => optionTextForMember(m)).filter(Boolean);
    let node = first.parentElement;
    for (let depth = 0; depth < 7 && node && node !== document.body; depth += 1) {
      if (members.every((m) => node.contains(m))) {
        let text = cleanLabelText(node.innerText || node.textContent || "");
        for (const opt of optionTexts) text = removeLastPhrase(text, opt);
        text = cleanScanLabel(text);
        if (text.length >= 3 && text.length <= 600) return text;
        if (text.length > 600) break;
      }
      node = node.parentElement;
    }
    const fallback = captureQuestionText(first);
    return optionTexts.includes(fallback) ? "" : fallback;
  }

  /** The nearest heading above a field ("Education", "Voluntary Self-Identification"). */
  function sectionHeadingFor(el) {
    let node = el;
    for (let depth = 0; depth < 10 && node && node !== document.body; depth += 1) {
      let sib = node.previousElementSibling;
      for (let hops = 0; sib && hops < 8; hops += 1) {
        const heading = sib.matches?.(SECTION_HEADING_SELECTOR)
          ? sib
          : sib.querySelector?.(SECTION_HEADING_CHILD_SELECTOR);
        const t = cleanLabelText(heading?.textContent || "");
        if (t && t.length <= 80) return t;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  function fieldIsRequired(el, label, members = [el]) {
    if (members.some((m) => controlIsRequired(m))) return true;
    const group = el.closest?.('[role="radiogroup"], [role="group"], fieldset');
    if (group && String(group.getAttribute("aria-required") || "").toLowerCase() === "true") {
      return true;
    }
    const text = String(label || "").trim();
    if (/\boptional\b/i.test(text)) return false;
    return /\*\s*$|^\*|\(required\)|\brequired\b/i.test(text);
  }

  /** What a custom dropdown currently shows as chosen, or "" when it is empty. */
  function comboboxDisplayValue(el) {
    const chips = selectedChipTexts(el);
    if (chips.length) return chips.join(", ");
    if (el.tagName === "BUTTON") {
      const t = cleanLabelText(el.textContent);
      return t && !/^(select|choose|please select|--)/i.test(t) ? t : "";
    }
    const shown = selectWidgetDisplayValue(el);
    if (!shown || isSelectPlaceholderText(shown) || isPlaceholderChoiceValue(shown)) return "";
    // A React-Select search input holds typed filter text, not a choice.
    if (isReactSelectInput(el) && normalize(shown) === normalize(el.value || "")) return "";
    return shown;
  }

  /** The real <select> a select2-style widget sits on top of, if any. */
  function nativeSelectBehind(el) {
    const root = getReactSelectRoot(el) || el;
    const container = root.closest?.(".select2-container, [class*='select2-container']") || root;
    if (container.previousElementSibling?.tagName === "SELECT") return container.previousElementSibling;
    return null;
  }

  /** Fields in a work / education entry the history filler already completed belong to it. */
  function insideFilledHistoryGroup(el) {
    let node = el.parentElement;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth += 1) {
      const marked = node.querySelectorAll("[data-resume-bot-history]").length;
      if (marked >= 2) {
        return node.querySelectorAll("input, textarea, select").length <= marked + 6;
      }
      node = node.parentElement;
    }
    return false;
  }

  /** The profile value for a matched key, in the words a form would show. */
  function readableProfileHint(applicantInfo, key) {
    if (!key) return "";
    const raw = String(applicantInfo?.[key] ?? "").trim();
    if (raw) {
      const labels = VALUE_LABELS[key]?.[raw];
      if (Array.isArray(labels) && labels.length) return labels[0];
      if (key === "state") return US_STATE_LABELS[raw.toUpperCase()] || raw;
      if (/^(yes|no)$/i.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      return raw.slice(0, 300);
    }
    // Derived values only — never the blank-profile Yes/No defaults, which are guesses.
    if (PLAN_MODE_RULE_KEYS.has(key)) {
      return String(resolveApplicantValue(applicantInfo, key) || "").slice(0, 300);
    }
    return "";
  }

  function hintFields(applicantInfo, key) {
    if (!key) return null;
    const hint = readableProfileHint(applicantInfo, key);
    return hint ? { profileKey: key, profileHint: hint } : { profileKey: key };
  }

  async function readComboboxOptions(el) {
    let nodes = [];
    try {
      openReactSelect(el);
      nodes = await waitForOptions(8, 90);
    } catch {
      nodes = [];
    }
    const options = [];
    const seen = new Set();
    for (const node of nodes) {
      const t = cleanLabelText(node.textContent);
      const n = normalize(t);
      if (!t || !n || seen.has(n)) continue;
      seen.add(n);
      options.push(t);
      if (options.length >= MAX_SCAN_OPTIONS) break;
    }
    // Close the menu so the next widget, and the page, stay usable.
    // Prefer Tab — Escape closes LinkedIn / Indeed application modals.
    const input = isReactSelectInput(el) ? el : el.querySelector?.("input") || el;
    try {
      const inAppModal = Boolean(
        input?.closest?.('[role="dialog"], dialog, [aria-modal="true"], [class*="modal" i], [class*="Modal"]')
      );
      pressKey(input, "Tab", "Tab");
      if (!inAppModal) {
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
      }
    } catch {
      /* ignore */
    }
    await sleep(60);
    return options;
  }

  function clearScanTags() {
    for (const el of document.querySelectorAll("[data-resume-bot-fid], [data-resume-bot-bid]")) {
      el.removeAttribute("data-resume-bot-fid");
      el.removeAttribute("data-resume-bot-fkind");
      el.removeAttribute("data-resume-bot-async");
      el.removeAttribute("data-resume-bot-bid");
    }
  }

  function scanPageInfo() {
    const headings = [];
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      if (!isElVisible(h)) continue;
      const t = cleanLabelText(h.textContent);
      if (t && t.length <= 120 && !headings.includes(t)) headings.push(t);
      if (headings.length >= 8) break;
    }
    const wd = isWorkdayPage() ? detectWorkdayWizardState() : null;
    return {
      url: location.href,
      title: cleanLabelText(document.title).slice(0, 160),
      headings,
      step: wd?.current || "",
      site: applyPageSite()
    };
  }

  /**
   * Compact visible form text for the planner — labels, legends, placeholders,
   * and nearby question copy the DOM scanner might miss. Cap keeps tokens low.
   */
  function scanFormTextExcerpt(maxChars = 3500) {
    const chunks = [];
    const seen = new Set();
    const push = (raw) => {
      const t = cleanLabelText(raw);
      if (!t || t.length < 2 || t.length > 240) return;
      const key = normalize(t);
      if (!key || seen.has(key)) return;
      seen.add(key);
      chunks.push(t);
    };

    const roots = [];
    const main =
      document.querySelector("main, [role='main'], form, [data-automation-id='applyFlow'], .application") ||
      document.body;
    if (main) roots.push(main);

    for (const root of roots) {
      for (const el of root.querySelectorAll(
        "label, legend, [role='heading'], h1, h2, h3, h4, p, span, div, li, th, td"
      )) {
        if (!isElVisible(el)) continue;
        if (el.closest("nav, header, footer, [role='navigation'], [aria-hidden='true']")) continue;
        // Prefer leaf-ish nodes so we do not duplicate parent+child text.
        if (el.children.length > 3) continue;
        const text = el.childNodes.length
          ? [...el.childNodes]
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent || "")
              .join(" ")
          : "";
        const candidate = text.trim() || (el.children.length === 0 ? el.textContent : "");
        if (candidate && candidate.length <= 200) push(candidate);
        if (chunks.join("\n").length >= maxChars) break;
      }
      for (const el of root.querySelectorAll("input, textarea, select, [placeholder], [aria-placeholder]")) {
        if (!isElVisible(el)) continue;
        push(el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || "");
        push(el.getAttribute("aria-label") || "");
        if (chunks.join("\n").length >= maxChars) break;
      }
      if (chunks.join("\n").length >= maxChars) break;
    }

    let out = "";
    for (const c of chunks) {
      const next = out ? `${out}\n${c}` : c;
      if (next.length > maxChars) break;
      out = next;
    }
    return out;
  }

  /** Visible buttons that could start, continue or submit the application. */
  function scanButtons(token) {
    const rows = [];
    const perText = new Map();
    const nodes = document.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"], a[href]'
    );
    for (const el of nodes) {
      if (!isElVisible(el) || !isElEnabled(el)) continue;
      if (isSiteChromeControl(el) || isInsideAdOrOverlay(el)) continue;
      const text = elActionText(el).slice(0, 80);
      if (!text || text.length < 2) continue;
      if (ENTRY_JUNK_RE.test(text)) continue;
      const hint = classifyActionButton(text) || (EASY_ENTRY_RE.test(text) ? "entry" : "");
      const href = el.tagName === "A" ? String(el.href || "") : "";
      if (href && isMarketingOrCorporateHref(href)) continue;
      // Plain links are navigation unless they read like an application action.
      // Do not include bare "Explore" / "Start" / marketing CTAs.
      if (el.tagName === "A") {
        const applyish =
          Boolean(hint) ||
          isApplicationActionText(text) ||
          /^\s*(i['’]?m interested|i am interested|start application|begin application)\s*$/i.test(
            text
          );
        if (!applyish) continue;
        if (href && /^https?:/i.test(href) && !isApplyRelatedHref(href)) continue;
      } else if (!hint && !isApplicationActionText(text) && !el.closest("form")) {
        // Outside forms, only keep controls that look like apply/next/submit.
        continue;
      }
      const key = normalize(text);
      const count = perText.get(key) || 0;
      if (count >= 2) continue;
      perText.set(key, count + 1);
      rows.push({
        el,
        text,
        hint,
        href: /^https?:/i.test(href) ? href.slice(0, 200) : "",
        inForm: Boolean(el.closest("form")),
        inDialog: Boolean(el.closest('[role="dialog"], dialog, [aria-modal="true"]'))
      });
    }
    // Buttons that already read like an application action first, then form buttons.
    rows.sort(
      (a, b) => Number(Boolean(b.hint)) - Number(Boolean(a.hint)) || Number(b.inForm) - Number(a.inForm)
    );
    return rows.slice(0, MAX_SCAN_BUTTONS).map((row, i) => {
      const id = `b_${token}_${i}`;
      row.el.setAttribute("data-resume-bot-bid", id);
      return {
        id,
        text: row.text,
        hint: row.hint,
        href: row.href,
        inForm: row.inForm,
        inDialog: row.inDialog
      };
    });
  }

  /**
   * Inventory the current application step for the AI planner.
   * `fields` holds only fields that still need an answer; `filled` summarises
   * the ones that already have one, so the model keeps its answers consistent.
   */
  async function scanApplicationForm({ applicantInfo = {}, buttonsOnly = false } = {}) {
    clearScanTags();
    const token = Math.random().toString(36).slice(2, 7);
    const page = scanPageInfo();
    const buttons = scanButtons(token);
    page.formText = scanFormTextExcerpt(3500);
    if (buttons.length) {
      page.buttons = buttons.map((b) => ({
        text: b.text,
        ...(b.hint ? { hint: b.hint } : null),
        ...(b.inForm ? { inForm: true } : null)
      }));
    }
    if (buttonsOnly) return { fields: [], filled: [], buttons, page };

    const fields = [];
    const filled = [];
    const handled = new Set();
    let comboOpens = 0;
    let n = 0;

    const tagField = (nodes, kind, { async = false } = {}) => {
      n += 1;
      const id = `f_${token}_${n}`;
      for (const node of nodes) {
        node.setAttribute("data-resume-bot-fid", id);
        node.setAttribute("data-resume-bot-fkind", kind);
        if (async) node.setAttribute("data-resume-bot-async", "1");
      }
      return id;
    };
    const noteFilled = (label, value) => {
      if (filled.length >= 40 || !label || !value || SCAN_SKIP_RE.test(label)) return;
      filled.push({ label: label.slice(0, 120), value: String(value).slice(0, 80) });
    };

    for (const el of document.querySelectorAll(SCAN_FIELD_SELECTOR)) {
      if (fields.length >= MAX_SCAN_FIELDS) break;
      if (handled.has(el)) continue;
      handled.add(el);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      // Parts of a widget that was already scanned (a combobox's inner input).
      if (el.parentElement?.closest("[data-resume-bot-fid]")) continue;
      if (isHistoryFilled(el) || insideFilledHistoryGroup(el)) continue;
      if (isInsideAdOrOverlay(el)) continue;
      if (el.closest("header, nav, footer") && !el.closest("form")) continue;

      const tagName = el.tagName;
      const type = String(el.type || "").toLowerCase();
      const rich = isRichTextEditor(el);

      if (tagName === "SELECT") {
        if (!isScanVisible(el)) continue;
        const label = cleanScanLabel(captureQuestionText(el));
        if (!label || SCAN_SKIP_RE.test(label)) continue;
        if (!isChoiceControlEmpty(el)) {
          noteFilled(label, readControlAnswer(el));
          continue;
        }
        const options = [...el.options]
          .map((o) => cleanLabelText(o.textContent || o.value || ""))
          .filter((t) => t && !isPlaceholderChoiceValue(t) && !isSelectPlaceholderText(t));
        if (!options.length) continue;
        fields.push({
          id: tagField([el], "select"),
          kind: "select",
          label: label.slice(0, 1000),
          section: sectionHeadingFor(el),
          required: fieldIsRequired(el, label),
          options: options.slice(0, MAX_SCAN_OPTIONS),
          ...(el.multiple ? { multiple: true } : null),
          ...hintFields(applicantInfo, matchApplicantKeyFromControl(el))
        });
        continue;
      }

      if (tagName === "INPUT" && (type === "radio" || type === "checkbox")) {
        const members = choiceGroupMembers(el).filter((m) => !m.disabled);
        members.forEach((m) => handled.add(m));
        if (!members.length || !members.some(isScanVisible)) continue;
        if (members.some((m) => isHistoryFilled(m))) continue;

        if (type === "radio" || members.length > 1) {
          const label = cleanScanLabel(groupQuestionText(members));
          const options = [...new Set(members.map((m) => optionTextForMember(m)).filter(Boolean))];
          if (!label || !options.length || SCAN_SKIP_RE.test(label)) continue;
          const ticked = members.filter((m) => m.checked);
          if (ticked.length) {
            noteFilled(label, ticked.map((m) => optionTextForMember(m)).join(", "));
            continue;
          }
          const kind = type === "radio" ? "radio" : "checkbox_group";
          const labelNorm = normalize(label);
          fields.push({
            id: tagField(members, kind),
            kind,
            label: label.slice(0, 1000),
            section: sectionHeadingFor(el),
            required: fieldIsRequired(el, label, members),
            options,
            ...(kind === "checkbox_group" ? { multiple: true } : null),
            ...hintFields(applicantInfo, matchApplicantKey(labelNorm, labelNorm))
          });
          continue;
        }

        // One box on its own: an agreement, a consent, or a yes/no question.
        const option = optionTextForMember(el, 600);
        const question = groupQuestionText([el]);
        const label = cleanScanLabel(
          [question, option].filter((t, i, all) => t && all.indexOf(t) === i).join(" — ")
        );
        if (!label || SCAN_SKIP_RE.test(label)) continue;
        if (el.checked) {
          noteFilled(label, "Yes");
          continue;
        }
        fields.push({
          id: tagField([el], "checkbox"),
          kind: "checkbox",
          label: label.slice(0, 1000),
          section: sectionHeadingFor(el),
          required: fieldIsRequired(el, label),
          options: ["Yes", "No"]
        });
        continue;
      }

      const comboLike =
        !rich &&
        tagName !== "TEXTAREA" &&
        (isReactSelectInput(el) ||
          looksLikeCombobox(el) ||
          isSelectPlaceholderWidget(el) ||
          (tagName === "INPUT" && looksLikeAsyncAutocomplete(el)));
      if (comboLike) {
        if (tagName === "INPUT" && !TEXT_INPUT_TYPES.has(type) && type !== "search") continue;
        if (!isScanVisible(el)) continue;
        // select2 keeps the real <select> next to its widget; that one was scanned instead.
        if (nativeSelectBehind(el)?.hasAttribute("data-resume-bot-fid")) continue;
        const label = cleanScanLabel(captureQuestionText(el));
        if (!label || SCAN_SKIP_RE.test(label) || /^search\b/i.test(label)) continue;
        const shown = comboboxDisplayValue(el);
        if (shown) {
          noteFilled(label, shown);
          continue;
        }
        const asyncList = tagName === "INPUT" && looksLikeAsyncAutocomplete(el);
        let options = [];
        const listId = el.getAttribute("list");
        if (listId) {
          options = [...(document.getElementById(listId)?.querySelectorAll("option") || [])]
            .map((o) => cleanLabelText(o.value || o.textContent || ""))
            .filter(Boolean)
            .slice(0, MAX_SCAN_OPTIONS);
        } else if (!asyncList && comboOpens < MAX_SCAN_COMBO_OPENS) {
          comboOpens += 1;
          options = await readComboboxOptions(el);
        }
        fields.push({
          id: tagField([el], "combobox", { async: asyncList && !listId }),
          kind: "combobox",
          label: label.slice(0, 1000),
          section: sectionHeadingFor(el),
          required: fieldIsRequired(el, label),
          ...(options.length ? { options } : { optionsAsync: true }),
          ...(isMultiSelectWidget(el) ? { multiple: true } : null),
          ...hintFields(applicantInfo, matchApplicantKeyFromControl(el))
        });
        continue;
      }

      if (tagName === "INPUT" && !TEXT_INPUT_TYPES.has(type)) continue;
      if (tagName !== "INPUT" && tagName !== "TEXTAREA" && !rich) continue;
      if (rich) {
        const inner = el.querySelector?.(
          '[contenteditable="true"], .ql-editor, .ProseMirror, .ck-editor__editable, .fr-element'
        );
        if (inner && inner !== el) continue; // the inner editor is its own candidate
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 30) continue;
      }
      if (!isScanVisible(el) || el.readOnly) continue;

      const label = cleanScanLabel(
        rich
          ? questionTextNearEditor(el)
          : questionTextForAi(el) ||
              questionLabelForControl(el) ||
              el.getAttribute("placeholder") ||
              identityHintFromControl(el)
      );
      const blob = normalize(
        [label, el.name, el.id, el.getAttribute("autocomplete")].filter(Boolean).join(" ")
      );
      if (!label || SCAN_SKIP_RE.test(label) || SCAN_SKIP_RE.test(blob)) continue;
      if (/^search\b/i.test(label)) continue;

      const current = rich
        ? isEditorEmpty(el)
          ? ""
          : editorPlainText(el)
        : cleanLabelText(el.value || "");
      if (current) {
        noteFilled(label, current);
        continue;
      }

      const kind = rich ? "richtext" : tagName === "TEXTAREA" ? "textarea" : "text";
      const placeholder = cleanLabelText(el.getAttribute("placeholder") || "");
      const maxLength = Number(el.getAttribute("maxlength") || 0);
      fields.push({
        id: tagField([el], kind),
        kind,
        label: label.slice(0, 1000),
        section: sectionHeadingFor(el),
        required: fieldIsRequired(el, label),
        ...(tagName === "INPUT" && type && type !== "text" ? { inputType: type } : null),
        ...(placeholder && placeholder.length <= 80 && normalize(placeholder) !== normalize(label)
          ? { placeholder }
          : null),
        ...(maxLength > 0 && maxLength < 100000 ? { maxLength } : null),
        ...hintFields(applicantInfo, matchApplicantKeyFromControl(el))
      });
    }

    return { fields, filled, buttons, page };
  }

  /** Index of the option a planned answer names: exact text first, then meaning. */
  function bestOptionIndex(texts, value) {
    const want = normalize(value);
    if (!want) return -1;
    const exact = texts.findIndex((t) => normalize(t) === want);
    if (exact >= 0) return exact;
    return texts.findIndex((t) => optionMatches(t, value));
  }

  function fillSelectByOption(select, value, values = []) {
    const opts = [...select.options];
    const texts = opts.map((o) => cleanLabelText(o.textContent || o.value || ""));
    const wanted = select.multiple && values.length ? values : [value];
    let picked = 0;
    for (const want of wanted) {
      const idx = bestOptionIndex(texts, want);
      if (idx < 0) continue;
      if (select.multiple) opts[idx].selected = true;
      else select.value = opts[idx].value;
      picked += 1;
      if (!select.multiple) break;
    }
    if (!picked) return false;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** Tick a radio / checkbox the way a click would, falling back to its label. */
  function checkChoiceInput(input) {
    if (input.checked) return true;
    try {
      input.click();
    } catch {
      /* ignore */
    }
    if (!input.checked) {
      try {
        labelElementFor(input)?.click();
      } catch {
        /* ignore */
      }
    }
    if (!input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return input.checked;
  }

  function fillRadioByOption(radios, value) {
    let idx = bestOptionIndex(
      radios.map((r) => optionTextForMember(r)),
      value
    );
    if (idx < 0) idx = radios.findIndex((r) => optionMatches(r.value || "", value));
    if (idx < 0) return false;
    return checkChoiceInput(radios[idx]);
  }

  function fillCheckboxGroupByOption(boxes, values) {
    const texts = boxes.map((b) => optionTextForMember(b));
    let ticked = 0;
    for (const want of values) {
      const idx = bestOptionIndex(texts, want);
      if (idx >= 0 && checkChoiceInput(boxes[idx])) ticked += 1;
    }
    return ticked > 0;
  }

  /**
   * Free text straight into the box. Unlike fillControl this never detours
   * through dropdown handling: the scan already proved this is a plain input,
   * so a planned "Yes" for "Are you willing to relocate?" is typed as-is.
   */
  function fillPlainText(el, value) {
    if (el.tagName === "TEXTAREA") {
      setNativeValue(el, value);
      return Boolean(String(el.value || "").trim());
    }
    const coerced = coerceValueForInput(el, value);
    if (coerced == null) return false;
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    const ok = setNativeValue(el, coerced);
    try {
      el.blur();
    } catch {
      /* ignore */
    }
    return ok && Boolean(String(el.value || "").trim());
  }

  async function fillPlannedField(kind, nodes, row) {
    const value = String(row?.value ?? "").trim();
    const values = Array.isArray(row?.values)
      ? row.values.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    if (!value && !values.length) return false;
    const el = nodes[0];
    switch (kind) {
      case "select":
        return fillSelectByOption(el, value, values);
      case "radio":
        return fillRadioByOption(nodes, value);
      case "checkbox":
        return /^y(es)?$/i.test(value) ? checkChoiceInput(el) : false;
      case "checkbox_group":
        return fillCheckboxGroupByOption(nodes, values.length ? values : [value]);
      case "combobox": {
        const wanted = values.length ? values : [value];
        if (el.getAttribute("data-resume-bot-async") === "1") {
          return fillAsyncAutocomplete(el, wanted[0], null);
        }
        let any = false;
        for (const want of wanted) {
          if (await fillCustomDropdown(el, want, null)) any = true;
          if (!isMultiSelectWidget(el)) break;
        }
        return any;
      }
      case "richtext":
        return fillContentEditable(el, value);
      default:
        return fillPlainText(el, value);
    }
  }

  /** Fill the planner's answers into the fields the last scan tagged. */
  async function applyFormPlan(answers = []) {
    const filled = [];
    const failed = [];
    for (const row of answers) {
      const id = String(row?.id || "").trim();
      if (!id) continue;
      let nodes = [];
      try {
        nodes = [...document.querySelectorAll(`[data-resume-bot-fid="${CSS.escape(id)}"]`)];
      } catch {
        nodes = [];
      }
      if (!nodes.length) {
        failed.push({ id, reason: "field is gone" });
        continue;
      }
      const kind = nodes[0].getAttribute("data-resume-bot-fkind") || String(row.kind || "text");
      // Our own fills must never be learned back into the bank as the user's answers.
      suppressLearn(4000);
      let ok = false;
      try {
        ok = await fillPlannedField(kind, nodes, row);
      } catch {
        ok = false;
      }
      if (!ok) {
        failed.push({ id, kind, reason: "no matching option, or the value was rejected" });
        continue;
      }
      filled.push({
        id,
        kind,
        preview: String(row.value || (row.values || []).join(", ")).slice(0, 80)
      });
      // Choice widgets often reveal follow-up fields; give the page a beat to render them.
      await sleep(CHOICE_FIELD_KINDS.has(kind) ? FIELD_FILL_DELAY_MS : 150);
    }
    suppressLearn(2500);
    return { filledCount: filled.length, filled, failedCount: failed.length, failed };
  }

  /**
   * Click a button the AI picked from the last scan. Refuses anything that looks
   * like sign-in, site chrome or an ad, and — unless allowed — a Submit button
   * on an application form: sending the application stays a rule/user decision.
   */
  async function clickScannedButton(id, { preferNewTab = false, allowSubmit = false } = {}) {
    let el = null;
    try {
      el = document.querySelector(`[data-resume-bot-bid="${CSS.escape(String(id || ""))}"]`);
    } catch {
      el = null;
    }
    if (!el || !isElVisible(el) || !isElEnabled(el)) {
      return { ok: false, clicked: false, error: "That button is no longer on the page." };
    }
    const text = elActionText(el);
    if (ENTRY_JUNK_RE.test(text) || isSiteChromeControl(el) || isInsideAdOrOverlay(el)) {
      return { ok: false, clicked: false, error: `Refused to click "${text}": not an application button.` };
    }
    if (!isApplicationActionText(text) && !el.closest("form")) {
      return {
        ok: false,
        clicked: false,
        error: `Refused to click "${text}": not Apply / Next / Submit related.`
      };
    }
    // Even inside a form, only click Apply / Next / Continue / Review / Submit.
    const cls = classifyActionButton(text);
    const looksEntry =
      EASY_ENTRY_RE.test(text) || EASY_APPLY_TEXT_RE.test(text) || APPLY_ONLY_TEXT_RE.test(text);
    if (!cls && !looksEntry && !allowSubmit) {
      return {
        ok: false,
        clicked: false,
        error: `Refused to click "${text}": only Apply / Next / Submit are allowed.`
      };
    }
    const href = String(el.href || el.getAttribute?.("href") || "");
    if (href && (isMarketingOrCorporateHref(href) || !isApplyRelatedHref(href))) {
      return {
        ok: false,
        clicked: false,
        error: `Refused to open non-apply URL for "${text}".`
      };
    }
    if (
      !allowSubmit &&
      classifyActionButton(text) === "submit" &&
      probeApplicationForm().isApplicationForm
    ) {
      return { ok: false, clicked: false, refusedSubmit: true, text };
    }
    if (uploadsStillBusy()) await waitForUploadsToSettle(15000);
    const res = await clickKeepingSameTab(el, { preferNewTab });
    if (res?.refused) {
      return { ok: false, clicked: false, error: res.error || "Refused non-apply navigation." };
    }
    return {
      ok: Boolean(res.clicked || res.navigateUrl),
      clicked: Boolean(res.clicked),
      navigateUrl: res.navigateUrl || "",
      openInNewTab: Boolean(res.openInNewTab),
      text
    };
  }

  /** The rule-based profile pass plan mode skips, for the legacy fallback. */
  async function fillAllMappedProfileFields(applicantInfo = {}) {
    const filled = [];
    for (const el of collectFillableControls()) {
      if (isHistoryFilled(el)) continue;
      const key = matchApplicantKeyFromControl(el);
      if (!key || PLAN_MODE_RULE_KEYS.has(key)) continue;
      const value = resolveApplicantValue(applicantInfo, key);
      if (!value) continue;
      if (await fillControl(el, value, key)) {
        filled.push({ key, label: labelTextForControl(el) });
        await pauseBetweenFields();
      }
    }
    return filled;
  }

  // ---- Learn mode: passively grow the Q&A bank from real user answers -------

  // Skip identity / PII / secrets / protected-class fields — those are handled by
  // deterministic profile fields and must never be persisted to an exportable bank.
  const LEARN_SENSITIVE_RE =
    /\b(password|otp|captcha|ssn|social security|credit card|card number|cvv|routing|account number|search|first name|last name|full name|middle name|legal name|email|e-mail|phone|mobile|telephone|address|street|city|state|province|zip|postal|country|linkedin|github|portfolio|website|date of birth|dob|birthday|salary|compensation|desired pay|expected pay|disability|veteran|military|\brace\b|ethnic|gender|\bsex\b|hispanic|latino|felony|conviction|criminal)\b/i;

  function captureQuestionText(el) {
    const q = questionLabelForControl(el);
    if (q && !isSelectPlaceholderText(q) && !/^(type here|enter text|write here|your answer|search)\.?$/i.test(q)) {
      return q;
    }
    const fieldset = el.closest("fieldset");
    const legend = fieldset?.querySelector(":scope > legend");
    if (legend) {
      const t = cleanLabelText(legend.textContent);
      if (t) return t;
    }
    const group = el.closest('[role="radiogroup"], [role="group"]');
    const aria = group?.getAttribute?.("aria-label");
    if (aria) return cleanLabelText(aria);
    const fromAi = questionTextForAi(el);
    if (fromAi) return fromAi;
    return q || "";
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

  // Job-page scraping lives in content/scrapers/ (see runner.js).

  let autofillInProgress = false;
  const autofillMessageListener = (message, _sender, sendResponse) => {
    if (message?.type === "autofill_ping") {
      sendResponse({ ok: true, build: SCRIPT_BUILD });
      return false;
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
    if (message?.type === "dismiss_page_overlays") {
      dismissBlockingModals({
        rounds: Math.min(6, Math.max(1, Number(message.rounds) || 3)),
        cookiesOnly: Boolean(message.cookiesOnly)
      })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "focus_submit_button") {
      try {
        const action = findActionButton(null, { includeDisabledSubmit: true });
        const el = action?.el || null;
        if (el) {
          highlightActionElement(el);
          try {
            el.focus?.({ preventScroll: true });
          } catch {
            try {
              el.focus?.();
            } catch {
              /* ignore */
            }
          }
          sendResponse({
            ok: true,
            focused: true,
            text: action.text || elActionText(el) || "Submit"
          });
        } else {
          sendResponse({ ok: true, focused: false, text: "" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
    if (message?.type === "highlight_apply_action") {
      try {
        const probe = probeApplicationForm();
        let action = null;
        if (probe.isApplicationForm) {
          action = findActionButton(null, { includeDisabledSubmit: true });
        } else {
          action = findEasyApplyEntryButton();
        }
        if (action?.el) {
          highlightActionElement(action.el);
          sendResponse({
            ok: true,
            highlighted: true,
            type: action.type || "",
            text: action.text || elActionText(action.el) || ""
          });
        } else {
          sendResponse({ ok: true, highlighted: false, type: "", text: "" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
    if (message?.type === "fill_greenhouse_security_code") {
      fillGreenhouseSecurityCode(message.code || "")
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
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
    if (message?.type === "dismiss_dice_success_wizard") {
      dismissDiceSuccessWizard()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, dismissed: false, error: String(err?.message || err) }));
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
    if (message?.type === "scan_application_form") {
      scanApplicationForm({
        applicantInfo: message.applicantInfo || {},
        buttonsOnly: Boolean(message.buttonsOnly)
      })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "apply_form_plan") {
      applyFormPlan(message.answers || [])
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "click_scanned_button") {
      clickScannedButton(message.id, {
        preferNewTab: Boolean(message.preferNewTab),
        allowSubmit: Boolean(message.allowSubmit)
      })
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "autofill_fallback_choices") {
      suppressLearn(8000);
      fillRemainingChoiceControls(message.applicantInfo || {}, { explicitOnly: true })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "collect_unmatched_questions") {
      // Legacy fallback after a failed AI form plan: the rule passes plan mode
      // skipped, then the per-question collection the old path answers.
      (async () => {
        const info = message.applicantInfo || {};
        suppressLearn(15000);
        const profileFilled = await fillAllMappedProfileFields(info);
        const choicePass = await fillRemainingChoiceControls(info);
        return {
          ok: true,
          filledCount: profileFilled.length + Number(choicePass.filledCount || 0),
          filled: [...profileFilled, ...(choicePass.filled || [])],
          unmatchedQuestions: collectUnmatchedQuestions(info),
          unmatchedChoiceQuestions: await collectUnmatchedChoiceQuestions()
        };
      })()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type !== "autofill_application") return undefined;
    if (autofillInProgress) {
      sendResponse({ ok: false, error: "Autofill already running on this page." });
      return false;
    }
    autofillInProgress = true;
    autofillApplication(
      message.applicantInfo || {},
      message.uploadFiles || {},
      message.credentials || {},
      {
        workHistory: message.workHistory || [],
        educationHistory: message.educationHistory || []
      },
      { mode: message.mode === "plan" ? "plan" : "legacy" }
    )
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
      .finally(() => {
        autofillInProgress = false;
      });
    return true;
  };
  window.__resumeBotAutofillMessageListener = autofillMessageListener;
  chrome.runtime.onMessage.addListener(autofillMessageListener);
})();
