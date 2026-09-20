/** @deprecated Prefer profiles.js */
export {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE_ID,
  getAllProfiles,
  getProfileById,
  buildPrompt
} from "./profiles.js";

import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID } from "./profiles.js";

export const PROMPT_TEMPLATE =
  BUILTIN_PROFILES.find((p) => p.id === DEFAULT_PROFILE_ID)?.promptTemplate || "";
