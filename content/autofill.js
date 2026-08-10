/**
 * Generic application-form autofill (content script).
 * Fills text, textarea, select, checkbox, and radio controls from applicant info.
 * For dropdowns/comboboxes: never types "yes"/"no" — opens the list and picks a matching option.
 */
(() => {
  // Keyed by build, not a plain boolean: a tab that already ran an older copy of
  // this script would otherwise block the updated one from installing.
  const SCRIPT_BUILD = "2026-08-10.2";
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
    phone: ["phone", "phone number", "mobile", "mobile phone", "cell", "telephone", "tel"],
    country: ["country", "country/region"],
    addressLine1: ["address", "address line 1", "street address", "address 1", "home address"],
    addressLine2: ["address line 2", "address 2", "apartment", "suite", "unit", "apt"],
    city: ["city", "town"],
    state: ["state", "province", "state/province", "region"],
    zipCode: ["zip", "zip code", "postal", "postal code", "zip/postal"],
    cityCountryOfResidence: [
      "city, country of residence",
      "city country of residence",
      "city and country of residence",
      "country of residence"
    ],

    workAuthorized: [
      "authorized to work",
      "legally authorized",
      "eligible to work",
      "work authorization",
      "right to work",
      "legally entitled to work"
    ],
    needsSponsorship: [
      "sponsorship",
      "visa sponsorship",
      "require sponsorship",
      "need sponsorship",
      "will you now or in the future require"
    ],
    postEmploymentRestrictions: [
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
    graduationDate: ["graduation", "graduation date", "date graduated", "graduated"],

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
    "state"
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

  function matchApplicantKey(labelNorm) {
    if (!labelNorm) return null;
    let best = null;
    let bestLen = 0;
    for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        const a = normalize(alias);
        if (!a) continue;
        if (labelNorm.includes(a) && a.length > bestLen) {
          best = key;
          bestLen = a.length;
        }
      }
    }
    return best;
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
    const label = labelTextForControl(el);
    const name = normalize(
      [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("accept"), label].join(" ")
    );
    if (/cover\s*letter|covering\s*letter|coverletter/.test(name)) return "coverLetter";
    if (/\b(resume|cv|curriculum|vitae)\b/.test(name)) return "resume";
    if (/\bcover\b/.test(name) && !/\b(resume|cv)\b/.test(name)) return "coverLetter";
    return "resume";
  }

  function setFileOnInput(input, file) {
    if (!input || !file) return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(
        new CustomEvent("file-upload-success", { bubbles: true, detail: { fileName: file.name } })
      );
      return input.files && input.files.length > 0;
    } catch {
      return false;
    }
  }

  function collectFileInputs() {
    return [...document.querySelectorAll('input[type="file"]')].filter((el) => {
      if (el.disabled) return false;
      return true;
    });
  }

  function uploadApplicationFiles(uploadFiles = {}) {
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
      return { uploadedCount: 0, uploaded, skipped: [{ reason: "no-docs" }] };
    }

    const inputs = collectFileInputs();
    if (!inputs.length) {
      return { uploadedCount: 0, uploaded, skipped: [{ reason: "no-file-inputs" }] };
    }

    const used = new WeakSet();

    for (const input of inputs) {
      const kind = classifyFileInput(input);
      let file = null;
      if (kind === "coverLetter" && coverFile) file = coverFile;
      else if (kind === "resume" && resumeFile) file = resumeFile;
      else if (kind === "coverLetter" && !coverFile && resumeFile) {
        skipped.push({ reason: "no-cover-letter-doc", label: labelTextForControl(input) });
        continue;
      } else if (resumeFile) file = resumeFile;

      if (!file || used.has(input)) continue;
      const ok = setFileOnInput(input, file);
      if (ok) {
        used.add(input);
        uploaded.push({
          kind,
          fileName: file.name,
          label: labelTextForControl(input)
        });
      } else {
        skipped.push({
          reason: "set-failed",
          kind,
          label: labelTextForControl(input)
        });
      }
    }

    return { uploadedCount: uploaded.length, uploaded, skipped };
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
      /\b(experience|interested|motivation|challenge|strength|weakness|about yourself|additional|comment|approach|follow.?up)\b/i.test(
        t
      )
    ) {
      return true;
    }
    return false;
  }

  function isMultilineControl(el) {
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
    if (String(el.value || "").trim()) return true;
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

    for (const el of nodes) {
      // Hard skip Greenhouse / React-Select — never AI-fill dropdown search inputs.
      if (isReactSelectInput(el) || looksLikeCombobox(el)) continue;

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.disabled || el.readOnly) continue;

      const labelNorm = labelTextForControl(el);
      const questionLabel = questionTextForAi(el);
      if (!labelNorm && !questionLabel) continue;
      if (shouldSkipAiField(el, labelNorm || questionLabel)) continue;

      const multiline = isMultilineControl(el);
      const key = matchApplicantKey(labelNorm);
      if (key) {
        const known = applicantInfo[key];
        if (known != null && String(known).trim()) continue;
        if (SKIP_AI_KNOWN_KEYS.has(key) || SELECT_LIKE_KEYS.has(key)) continue;
        const questionLike =
          looksLikeQuestionLabel(questionLabel) || looksLikeQuestionLabel(labelNorm);
        if (
          !questionLike &&
          !multiline &&
          key !== "whyInterested" &&
          key !== "relevantExperience"
        ) {
          continue;
        }
      } else {
        const questionLike =
          looksLikeQuestionLabel(questionLabel) || looksLikeQuestionLabel(labelNorm);
        if (!questionLike && !multiline) continue;
        if (multiline && !questionLike && String(questionLabel || labelNorm).trim().length < 12) {
          continue;
        }
      }

      if (questions.length >= 10) break;

      const labelForAi = (questionLabel || labelNorm).slice(0, 1000);
      const id = `rbq_${questions.length}_${Math.abs(
        Array.from(labelForAi).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) | 0, 7)
      )}`;
      el.setAttribute("data-resume-bot-qid", id);
      questions.push({
        id,
        label: labelForAi,
        multiline
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
  function collectUnmatchedChoiceQuestions() {
    const out = [];
    const groupIds = new Map(); // labelNorm -> id (radio/checkbox groups share one)
    const nodes = [
      ...document.querySelectorAll('select, input[type="radio"], input[type="checkbox"]')
    ];

    for (const el of nodes) {
      if (out.length >= 15) break;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.disabled) continue;
      if (isReactSelectInput(el)) continue;

      // Known profile fields are handled by the deterministic autofill loop.
      if (matchApplicantKey(labelTextForControl(el))) continue;

      const label = captureQuestionText(el);
      if (!label) continue;
      if (LEARN_SENSITIVE_RE.test(label)) continue;
      const labelNorm = normalize(label);
      if (!labelNorm || labelNorm.length < 6) continue;

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
      out.push({ id, label: label.slice(0, 1000) });
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
    return "";
  }

  async function autofillApplication(applicantInfo = {}, uploadFiles = {}, credentials = {}) {
    suppressLearn();
    const filled = [];
    const controls = collectFillableControls();

    for (const el of controls) {
      const label = labelTextForControl(el);
      const key = matchApplicantKey(label);
      if (!key) continue;
      const value = resolveApplicantValue(applicantInfo, key);
      if (!value) continue;
      if (await fillControl(el, value, key)) filled.push({ key, label });
    }

    // Fill saved login/sign-up credentials when this page has a Create Login section.
    const creds = {
      email: String(credentials.email || applicantInfo.email || "").trim(),
      username: String(credentials.username || "").trim(),
      password: String(credentials.password || "")
    };
    const credResult = fillLoginCredentials(creds);

    const uploadResult = uploadApplicationFiles(uploadFiles);
    const unmatchedQuestions = collectUnmatchedQuestions(applicantInfo);
    const unmatchedChoiceQuestions = collectUnmatchedChoiceQuestions();

    return {
      ok: true,
      filledCount: filled.length,
      filled,
      credentialFilledCount: credResult.filledCount,
      credentialFilled: credResult.filled,
      uploadedCount: uploadResult.uploadedCount,
      uploaded: uploadResult.uploaded,
      uploadSkipped: uploadResult.skipped,
      unmatchedQuestions,
      unmatchedChoiceQuestions
    };
  }

  function collectApplyUrlCandidates() {
    const applyUrls = [];
    const seen = new Set();

    const applyRe =
      /\bapply\b|\bstart application\b|\bbegin application\b|\bcontinue\b|\bget started\b|\bsubmit\b|\bnext\b/i;

    function pushUrl(href) {
      const url = String(href || "").trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) return;
      if (seen.has(url)) return;
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
      'h1, h2, [role="heading"], .error, [class*="error"], [class*="not-found"], [class*="notFound"], [class*="expired"], [class*="unavailable"], [class*="empty-state"]'
    );
    let count = 0;
    for (const el of nodes) {
      const t = cleanLabelText(el.textContent);
      if (t && t.length <= 300) parts.push(t);
      if (++count > 40) break;
    }
    return parts.join("  ").slice(0, 4000);
  }

  /** @returns {string} a short reason when the job is gone, else "" */
  function detectJobUnavailable() {
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
      const key = matchApplicantKey(labelTextForControl(el));
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

    const isApplicationForm =
      hasFileInput || identityFields >= 2 || (hasApplyForm && fillableCount >= 2);

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
      applyUrls: collectApplyUrlCandidates()
    };
  }

  // ---- Easy Apply (multi-step) driver: Dice / Jobright ---------------------

  const EASY_NEXT_RE = /\b(next|continue|save\s*(and|&)\s*continue|save and next|proceed)\b/i;
  const EASY_REVIEW_RE = /\breview\b/i;
  const EASY_SUBMIT_RE =
    /\b(submit application|submit|apply now|send application|finish|complete application)\b/i;
  const EASY_BACK_RE = /\b(back|previous|cancel|close|dismiss)\b/i;
  const EASY_ENTRY_RE = /\b(easy apply|1-?click apply|one-?click apply|quick apply|apply now|apply)\b/i;

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

  /** The most form-dense visible dialog/modal, or the document when none. */
  function getApplyScope() {
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

  function classifyActionButton(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 60) return null;
    if (EASY_NEXT_RE.test(t)) return "next";
    if (EASY_REVIEW_RE.test(t)) return "review";
    if (EASY_SUBMIT_RE.test(t)) return "submit";
    return null;
  }

  /**
   * Pick the forward action. Priority next > review > submit so we advance
   * through review pages to reach the real submit, then stop there.
   */
  function findActionButton(scope) {
    const scopeEl = scope || getApplyScope();
    const buttons = [
      ...scopeEl.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]'
      )
    ].filter((el) => isElVisible(el) && isElEnabled(el));

    let next = null;
    let review = null;
    let submit = null;
    for (const btn of buttons) {
      const text = elActionText(btn);
      if (EASY_BACK_RE.test(text) && !EASY_NEXT_RE.test(text) && !EASY_SUBMIT_RE.test(text)) {
        continue;
      }
      const cls = classifyActionButton(text);
      if (cls === "next" && !next) next = btn;
      else if (cls === "review" && !review) review = btn;
      else if (cls === "submit" && !submit) submit = btn;
    }
    if (next) return { type: "next", el: next };
    if (review) return { type: "review", el: review };
    if (submit) return { type: "submit", el: submit };
    return null;
  }

  async function clickEasyApplyEntry() {
    const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(
      (el) => isElVisible(el) && isElEnabled(el)
    );
    const preferred = controls.find((el) =>
      /easy apply|1-?click apply|one-?click apply|quick apply/i.test(elActionText(el))
    );
    const target = preferred || controls.find((el) => EASY_ENTRY_RE.test(elActionText(el)));
    if (!target) return false;
    scrollElIntoView(target);
    target.click();
    await sleep(1200);
    return true;
  }

  function stepSignature() {
    const scope = getApplyScope();
    const heading = cleanLabelText(
      scope.querySelector?.('h1, h2, h3, [role="heading"], legend')?.textContent || ""
    );
    const fields = scope.querySelectorAll?.("input, textarea, select").length || 0;
    return `${location.href}|${heading}|${fields}`;
  }

  async function waitForStepChange(prevSig, timeoutMs = 9000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(350);
      if (stepSignature() !== prevSig) {
        await sleep(300); // let the new step settle
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

  async function requestChoiceAnswersFromSw(questions, profileId) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "easy_apply_choice_answers",
        questions,
        profileId
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
    maxSteps = 8
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

      const fillRes = await autofillApplication(applicantInfo, uploadFiles, credentials);
      summary.filled += Number(fillRes.filledCount || 0);
      summary.uploaded += Number(fillRes.uploadedCount || 0);

      // Reuse stored answers for novel dropdown/checkbox/radio questions.
      const choiceQuestions = Array.isArray(fillRes.unmatchedChoiceQuestions)
        ? fillRes.unmatchedChoiceQuestions
        : [];
      if (choiceQuestions.length) {
        const choiceAnswers = await requestChoiceAnswersFromSw(choiceQuestions, profileId);
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
          scrollElIntoView(action.el);
          action.el.click();
          summary.status = "submitted";
          summary.detail = "Submitted the application.";
          return summary;
        }
        summary.status = "ready_for_review";
        summary.detail = "Reached the final Submit step. Stopped so you can review and submit.";
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
    const profileKey = matchApplicantKey(labelTextForControl(el));
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

    // Only novel CHOICE questions (dropdown / checkbox / radio) are stored for
    // reuse — their answers are stable across roles. Free-text questions (e.g.
    // "most challenging project") depend on the role/JD, so those are always
    // AI-generated per application and never stored here.
    const isChoice = el.tagName === "SELECT" || type === "radio" || type === "checkbox";
    if (!isChoice) return;

    const label = captureQuestionText(el);
    if (!label) return;
    if (LEARN_SENSITIVE_RE.test(label)) return;

    const labelNorm = normalize(label);
    if (!labelNorm || labelNorm.length < 6) return;

    if (learnSentByQuestion.get(labelNorm) === answer) return;
    learnSentByQuestion.set(labelNorm, answer);

    try {
      chrome.runtime.sendMessage({
        type: "qa_learn_capture",
        question: label.slice(0, 1000),
        answer: answer.slice(0, 2000),
        fieldType: "choice",
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
    if (message?.type === "easy_apply_run") {
      runEasyApply({
        applicantInfo: message.applicantInfo || {},
        uploadFiles: message.uploadFiles || {},
        credentials: message.credentials || {},
        profileId: message.profileId || "",
        jobMeta: message.jobMeta || {},
        site: message.site || "generic",
        autoSubmit: Boolean(message.autoSubmit)
      })
        .then((summary) => sendResponse(summary))
        .catch((err) => sendResponse({ ok: false, status: "failed", error: String(err?.message || err) }));
      return true;
    }
    if (message?.type !== "autofill_application") return undefined;
    autofillApplication(
      message.applicantInfo || {},
      message.uploadFiles || {},
      message.credentials || {}
    )
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
