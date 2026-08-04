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
  { value: "yes", label: "Yes, I have a disability" },
  { value: "no", label: "No, I do not have a disability" },
  { value: "decline", label: "I do not wish to answer" }
];

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

    // Work eligibility
    workAuthorized: "",
    needsSponsorship: "",
    willingToRelocate: "",
    over18: "",
    felonyConviction: "",
    felonyExplanation: "",

    // Experience / links
    yearsExperience: "",
    relevantExperience: "",
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
    raceEthnicity: "",
    veteranStatus: "",
    disabilityStatus: ""
  };
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
