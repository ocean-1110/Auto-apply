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
      // Prefer label text excluding the control's own value/placeholder noise.
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

    // Pick the longest meaningful candidate (question prompts are usually longest).
    let best = "";
    for (const c of candidates) {
      if (!c) continue;
      if (/^(type here|enter text|write here|your answer)\.?$/i.test(c)) continue;
      if (c.length > best.length) best = c;
    }
    if (best) return best.slice(0, 1000);

    // Fallback to normalized match blob (still useful for detection).
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
      // Some ATS listen for drop-style events.
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
      // Include visually hidden inputs — many ATS hide the real file control.
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
    // Prefer question-like or open-ended prompts (works on raw or normalized text).
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
    if (["password", "email", "tel", "url", "number", "date", "month", "week", "time", "color", "range"].includes(type)) {
      return true;
    }
    const blob = normalize(
      [label, el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("placeholder")].join(" ")
    );
    if (
      /\b(password|otp|captcha|ssn|social security|credit card|card number|cvv|routing|account number|search)\b/.test(
        blob
      )
    ) {
      return true;
    }
    // Skip fields that already have content.
    if (String(el.value || "").trim()) return true;
    return false;
  }

  function collectUnmatchedQuestions(applicantInfo = {}) {
    const questions = [];
    const nodes = [...document.querySelectorAll("input, textarea")].filter((el) => {
      const type = (el.type || "text").toLowerCase();
      if (el.tagName === "TEXTAREA") return true;
      if (el.tagName === "INPUT" && ["text", "search", ""].includes(type)) return true;
      return false;
    });

    for (const el of nodes) {
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
        // Known mapping exists — even if empty, don't send to AI (profile should fill it).
        if (known != null && String(known).trim()) continue;
        // Empty known field: still skip AI for identity/legal fields.
        if (
          [
            "firstName",
            "lastName",
            "email",
            "phone",
            "zipCode",
            "city",
            "state",
            "country",
            "workAuthorized",
            "needsSponsorship"
          ].includes(key)
        ) {
          continue;
        }
        // For empty optional known text like whyInterested, allow AI if question-like or multiline.
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
        // Unmatched textareas are strong AI candidates (custom app questions).
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

  function fillAiAnswers(answers = []) {
    const filled = [];
    for (const row of answers) {
      const id = String(row?.id || "").trim();
      const answer = String(row?.answer || "").trim();
      if (!id || !answer) continue;
      const el = document.querySelector(`[data-resume-bot-qid="${CSS.escape(id)}"]`);
      if (!el) continue;
      if (fillControl(el, answer)) {
        filled.push({ id, label: labelTextForControl(el), preview: answer.slice(0, 80) });
      }
    }
    return { filledCount: filled.length, filled };
  }

  function autofillApplication(applicantInfo = {}, uploadFiles = {}) {
    const filled = [];
    const controls = [...document.querySelectorAll("input, textarea, select")].filter((el) => {
      const type = (el.type || "").toLowerCase();
      if (type === "file") return false; // handled separately
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

    const uploadResult = uploadApplicationFiles(uploadFiles);
    const unmatchedQuestions = collectUnmatchedQuestions(applicantInfo);

    return {
      ok: true,
      filledCount: filled.length,
      filled,
      uploadedCount: uploadResult.uploadedCount,
      uploaded: uploadResult.uploaded,
      uploadSkipped: uploadResult.skipped,
      unmatchedQuestions
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "autofill_ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "autofill_ai_answers") {
      try {
        sendResponse({ ok: true, ...fillAiAnswers(message.answers || []) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }
    if (message?.type !== "autofill_application") return undefined;
    try {
      sendResponse(
        autofillApplication(message.applicantInfo || {}, message.uploadFiles || {})
      );
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  });
})();
