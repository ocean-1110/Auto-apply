/** Common US job-application fields stored per resume profile. */

export const APPLICANT_INFO_KEY = "applicant_info_by_profile";

export const US_STATES = [
  { value: "", label: "—" },
  { value: "AL", label: "Alabama" },
  { value: "AK", label: "Alaska" },
  { value: "AZ", label: "Arizona" },
  { value: "AR", label: "Arkansas" },
  { value: "CA", label: "California" },
  { value: "CO", label: "Colorado" },
  { value: "CT", label: "Connecticut" },
  { value: "DE", label: "Delaware" },
  { value: "DC", label: "District of Columbia" },
  { value: "FL", label: "Florida" },
  { value: "GA", label: "Georgia" },
  { value: "HI", label: "Hawaii" },
  { value: "ID", label: "Idaho" },
  { value: "IL", label: "Illinois" },
  { value: "IN", label: "Indiana" },
  { value: "IA", label: "Iowa" },
  { value: "KS", label: "Kansas" },
  { value: "KY", label: "Kentucky" },
  { value: "LA", label: "Louisiana" },
  { value: "ME", label: "Maine" },
  { value: "MD", label: "Maryland" },
  { value: "MA", label: "Massachusetts" },
  { value: "MI", label: "Michigan" },
  { value: "MN", label: "Minnesota" },
  { value: "MS", label: "Mississippi" },
  { value: "MO", label: "Missouri" },
  { value: "MT", label: "Montana" },
  { value: "NE", label: "Nebraska" },
  { value: "NV", label: "Nevada" },
  { value: "NH", label: "New Hampshire" },
  { value: "NJ", label: "New Jersey" },
  { value: "NM", label: "New Mexico" },
  { value: "NY", label: "New York" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "OH", label: "Ohio" },
  { value: "OK", label: "Oklahoma" },
  { value: "OR", label: "Oregon" },
  { value: "PA", label: "Pennsylvania" },
  { value: "RI", label: "Rhode Island" },
  { value: "SC", label: "South Carolina" },
  { value: "SD", label: "South Dakota" },
  { value: "TN", label: "Tennessee" },
  { value: "TX", label: "Texas" },
  { value: "UT", label: "Utah" },
  { value: "VT", label: "Vermont" },
  { value: "VA", label: "Virginia" },
  { value: "WA", label: "Washington" },
  { value: "WV", label: "West Virginia" },
  { value: "WI", label: "Wisconsin" },
  { value: "WY", label: "Wyoming" }
];

export const YES_NO_OPTIONS = [
  { value: "", label: "—" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" }
];

export const DEGREE_OPTIONS = [
  { value: "", label: "—" },
  { value: "high_school", label: "High School" },
  { value: "associate", label: "Associate's" },
  { value: "bachelor", label: "Bachelor's" },
  { value: "master", label: "Master's" },
  { value: "doctorate", label: "Doctorate / PhD" },
  { value: "other", label: "Other" }
];

export const GENDER_OPTIONS = [
  { value: "", label: "Prefer not to say" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "non_binary", label: "Non-binary" },
  { value: "other", label: "Other / Self-describe" }
];

export const RACE_OPTIONS = [
  { value: "", label: "Prefer not to say" },
  { value: "american_indian", label: "American Indian or Alaska Native" },
  { value: "asian", label: "Asian" },
  { value: "black", label: "Black or African American" },
  { value: "hispanic", label: "Hispanic or Latino" },
  { value: "native_hawaiian", label: "Native Hawaiian or Other Pacific Islander" },
  { value: "white", label: "White" },
  { value: "two_or_more", label: "Two or more races" }
];

export const VETERAN_OPTIONS = [
  { value: "", label: "Prefer not to say" },
  { value: "not_veteran", label: "I am not a protected veteran" },
  { value: "protected_veteran", label: "I identify as a protected veteran" },
  { value: "decline", label: "I decline to self-identify" }
];

export const DISABILITY_OPTIONS = [
  { value: "", label: "Prefer not to say" },
  { value: "yes", label: "Yes, I have a disability, or have had one in the past" },
  {
    value: "no",
    label: "No, I do not have a disability and have not had one in the past"
  },
  { value: "decline", label: "I do not want to answer" }
];

export const ENGLISH_LEVEL_OPTIONS = [
  { value: "", label: "—" },
  { value: "A1", label: "A1" },
  { value: "A2", label: "A2" },
  { value: "B1", label: "B1" },
  { value: "B2", label: "B2" },
  { value: "C1", label: "C1" },
  { value: "C2", label: "C2" },
  { value: "native", label: "Native / bilingual" }
];

export const HISPANIC_OPTIONS = [
  { value: "", label: "Prefer not to say" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" }
];

/**
 * Human-readable labels + synonyms for stored enum values.
 * Autofill uses these to match dropdown option text (case-insensitive).
 */
export const APPLICANT_VALUE_LABELS = {
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
    hispanic: ["Hispanic or Latino", "Hispanic", "Latino", "Latinx", "Spanish Origin"],
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
    bachelor: ["Bachelor", "Bachelor's", "Bachelors", "BS", "BA", "B.S.", "B.A."],
    master: ["Master", "Master's", "Masters", "MS", "MA", "M.S.", "M.A.", "MBA"],
    doctorate: ["Doctorate", "PhD", "Ph.D.", "Doctoral"],
    other: ["Other"]
  }
};

/** Empty applicant info shape used for forms and autofill. */
export function createEmptyApplicantInfo() {
  return {
    // Personal
    firstName: "",
    lastName: "",
    middleName: "",
    preferredName: "",
    email: "",
    phone: "",
    country: "United States",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    zipCode: "",
    cityCountryOfResidence: "",

    // Work eligibility
    workAuthorized: "",
    needsSponsorship: "",
    postEmploymentRestrictions: "",
    willingToRelocate: "",
    over18: "",
    felonyConviction: "",
    felonyExplanation: "",

    // Experience / links
    yearsExperience: "",
    relevantExperience: "",
    // Free-form source of truth about the candidate (verified background, prior
    // resume, technologies, metrics). Fills {CANDIDATE_INFORMATION} in the prompt.
    candidateInfo: "",
    // Real projects delivered in past roles. Never autofilled into a form —
    // it feeds resume generation, ATS rewrite, and AI answers. See project-manifest.js.
    projectManifest: "",
    englishLevel: "",
    linkedinUrl: "",
    portfolioUrl: "",
    githubUrl: "",

    // Education
    highestDegree: "",
    schoolName: "",
    fieldOfStudy: "",
    graduationDate: "",

    // Template answers
    whyInterested: "",
    salaryExpectation: "",
    earliestStartDate: "",
    backgroundCheckConsent: "",
    drugTestConsent: "",

    // EEO (voluntary)
    gender: "",
    hispanicLatino: "",
    raceEthnicity: "",
    veteranStatus: "",
    disabilityStatus: ""
  };
}

/** Expand a stored field value into candidate strings for dropdown matching. */
export function expandApplicantValueCandidates(key, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const out = [raw];
  const map = APPLICANT_VALUE_LABELS[key];
  if (map && map[raw]) {
    for (const label of map[raw]) {
      if (label && !out.includes(label)) out.push(label);
    }
  }
  // Always try Title Case for short yes/no style answers.
  if (/^(yes|no)$/i.test(raw)) {
    const titled = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (!out.includes(titled)) out.push(titled);
  }
  return out;
}

export async function getAllApplicantInfo() {
  const data = await chrome.storage.local.get(APPLICANT_INFO_KEY);
  const map = data[APPLICANT_INFO_KEY];
  return map && typeof map === "object" ? map : {};
}

export async function getApplicantInfo(profileId) {
  if (!profileId) return createEmptyApplicantInfo();
  const map = await getAllApplicantInfo();
  const saved = map[profileId];
  return {
    ...createEmptyApplicantInfo(),
    ...(saved && typeof saved === "object" ? saved : {})
  };
}

export async function saveApplicantInfo(profileId, info) {
  if (!profileId) throw new Error("Profile id is required.");
  const map = await getAllApplicantInfo();
  const next = {
    ...createEmptyApplicantInfo(),
    ...(info && typeof info === "object" ? info : {})
  };
  map[profileId] = next;
  await chrome.storage.local.set({ [APPLICANT_INFO_KEY]: map });
  return next;
}

export async function deleteApplicantInfo(profileId) {
  if (!profileId) return;
  const map = await getAllApplicantInfo();
  if (!(profileId in map)) return;
  delete map[profileId];
  await chrome.storage.local.set({ [APPLICANT_INFO_KEY]: map });
}
