/**
 * Generic application-form autofill (content script).
 * Fills text, textarea, select, checkbox, and radio controls from applicant info.
 */
(() => {
  if (window.__resumeBotAutofillInstalled) return;
  window.__resumeBotAutofillInstalled = true;

  const FIELD_ALIASES = {
    firstName: ["first name", "firstname", "given name", "legal first name"],
    lastName: ["last name", "lastname", "surname", "family name", "legal last name"],
    middleName: ["middle name", "middle initial", "mi"],
    preferredName: ["preferred name", "preferred first name", "nickname", "what should we call you"],
    email: ["email", "e-mail", "email address", "work email"],
    phone: ["phone", "phone number", "mobile", "mobile phone", "cell", "telephone", "tel"],
    country: ["country", "country/region", "country of residence"],
    addressLine1: ["address", "address line 1", "street address", "address 1", "home address"],
    addressLine2: ["address line 2", "address 2", "apartment", "suite", "unit", "apt"],
    city: ["city", "town"],
    state: ["state", "province", "state/province", "region"],
    zipCode: ["zip", "zip code", "postal", "postal code", "zip/postal"],

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
    willingToRelocate: ["relocate", "willing to relocate", "relocation"],
    over18: ["over 18", "at least 18", "18 years of age", "age of majority"],
    felonyConviction: ["felony", "criminal conviction", "convicted of a crime", "criminal record"],
    felonyExplanation: ["please explain", "conviction explanation", "explain your"],

    yearsExperience: ["years of experience", "total experience", "years experience", "how many years"],
    relevantExperience: ["relevant experience", "describe your experience"],
    linkedinUrl: ["linkedin", "linkedin url", "linkedin profile"],
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
    raceEthnicity: ["race", "ethnicity", "race/ethnicity", "racial"],
    veteranStatus: ["veteran", "military status", "protected veteran"],
    disabilityStatus: ["disability", "disabled"]
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

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
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
    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) parts.push(legend.textContent || "");
    }
    return normalize(parts.join(" "));
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

  function optionMatches(optionText, desired) {
    const opt = normalize(optionText);
    const want = normalize(desired);
    if (!opt || !want) return false;
    if (opt === want) return true;
    if (opt.includes(want) || want.includes(opt)) return true;
    if (isYesNoValue(want)) {
      const yes = YES_VALUES.has(want);
      if (yes && (opt === "yes" || opt.startsWith("yes ") || opt === "y")) return true;
      if (!yes && (opt === "no" || opt.startsWith("no ") || opt === "n")) return true;
    }
    return false;
  }

  function fillSelect(select, value) {
    if (value == null || value === "") return false;
    const match = [...select.options].find((o) =>
      optionMatches(o.textContent || o.value, value)
    );
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fillCheckboxOrRadio(el, value) {
    if (value == null || value === "") return false;
    const wantYes = YES_VALUES.has(normalize(value));
    const label = labelTextForControl(el);
    const optionSide = normalize(el.value || "") || label;

    if (el.type === "checkbox") {
      const shouldCheck = isYesNoValue(value)
        ? wantYes
        : optionMatches(optionSide, value) || optionMatches(label, value);
      if (el.checked !== shouldCheck) el.click();
      return true;
    }

    if (el.type === "radio") {
      const matchesOption =
        optionMatches(el.value, value) || optionMatches(optionSide, value);
      const yesNoOnGroup =
        isYesNoValue(value) &&
        ((wantYes && (optionSide.includes("yes") || optionSide === "y")) ||
          (!wantYes && (optionSide.includes("no") || optionSide === "n")));
      if (matchesOption || yesNoOnGroup) {
        if (!el.checked) el.click();
        return true;
      }
    }
    return false;
  }

  function fillControl(el, value) {
    if (value == null || String(value).trim() === "") return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return fillSelect(el, value);
    if (tag === "textarea") {
      setNativeValue(el, String(value));
      return true;
    }
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return fillCheckboxOrRadio(el, value);
      if (["hidden", "file", "submit", "button", "image", "reset"].includes(type)) return false;
      setNativeValue(el, String(value));
      return true;
    }
    return false;
  }

  function autofillApplication(applicantInfo = {}) {
    const filled = [];
    const controls = [...document.querySelectorAll("input, textarea, select")].filter((el) => {
      const type = (el.type || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button") return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return true;
    });

    for (const el of controls) {
      const label = labelTextForControl(el);
      const key = matchApplicantKey(label);
      if (!key) continue;
      const value = applicantInfo[key];
      if (value == null || String(value).trim() === "") continue;
      if (fillControl(el, value)) filled.push({ key, label });
    }

    return { ok: true, filledCount: filled.length, filled };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "autofill_ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "autofill_application") return undefined;
    try {
      sendResponse(autofillApplication(message.applicantInfo || {}));
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  });
})();
