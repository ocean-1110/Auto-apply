import { normalizeEducation, normalizeExperience, normalizeSkills } from "./templates/shared.js";

const EXPECTED_BULLET_COUNTS = [
  { match: /sfa\s*solutions/i, count: 6 },
  { match: /^amazon$/i, count: 5 },
  { match: /bhg\s*financial/i, count: 5 },
  { match: /scholastic/i, count: 4 },
  { match: /vonage/i, count: 4 },
  { match: /forefront/i, count: 4 }
];

export function stripMarkdownFences(text) {
  let trimmed = String(text || "").trim();
  if (/^```/m.test(trimmed)) {
    trimmed = trimmed
      .replace(/^```(?:json|JSON|html|HTML)?\s*\r?\n?/, "")
      .replace(/\r?\n?```\s*$/, "")
      .trim();
  }
  return trimmed;
}

function normalizeJsonText(text) {
  let trimmed = stripMarkdownFences(text)
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00A0/g, " ")
    .trim();

  // ChatGPT code blocks sometimes prefix a bare language label.
  trimmed = trimmed.replace(/^(json|JSON)\s*\r?\n/, "");

  // Un-mangle markdown-linkified JSON. When ChatGPT prints raw JSON (no code
  // fence) it auto-links emails/URLs; copying that rendered text injects
  // `[label](url)` wrappers where the url is percent-encoded and the label
  // keeps the original characters (real quotes/commas). Keep the label so the
  // JSON field boundaries are restored. A `]` immediately followed by `(` does
  // not occur in clean resume JSON, so this is safe for well-formed input.
  if (/\]\(/.test(trimmed)) {
    trimmed = trimmed.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  }

  // Strip common line-number gutters: "12|{..." or "12 {...".
  if (/^\s*\d+\s*[|:]/.test(trimmed) || /\n\s*\d+\s*[|:]/.test(trimmed)) {
    trimmed = trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+\s*[|:]\s?/, ""))
      .join("\n");
  }

  return trimmed.trim();
}

/**
 * Scan text for every balanced {...} block (ignoring braces inside strings)
 * and return the parsed objects. This survives leading/trailing prose,
 * code-fence leftovers, and multiple JSON-ish blocks in one message.
 */
function extractBalancedJsonObjects(text) {
  const str = String(text || "");
  const objects = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) startIdx = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && startIdx >= 0) {
          const candidate = str.slice(startIdx, i + 1);
          try {
            objects.push(JSON.parse(candidate));
          } catch {
            // ignore non-parseable slice
          }
          startIdx = -1;
        }
      }
    }
  }

  return objects;
}

/**
 * Repair JSON that was truncated mid-copy (a very common paste problem):
 * append the missing closing brackets/braces based on a bracket stack that
 * ignores anything inside strings. Also drops a dangling trailing comma.
 * Returns null when the tail cannot be safely closed (e.g. unterminated string).
 */
function closeTruncatedJson(text) {
  const str = String(text || "");
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // An unterminated string can't be closed reliably; bail out.
  if (inString || !stack.length) return null;

  // Remove trailing whitespace and a dangling comma before appending closers.
  let repaired = str.replace(/\s+$/, "").replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
}

function tryParseJson(text) {
  const trimmed = normalizeJsonText(text);
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // Fast path: first "{" to last "}".
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // continue to balanced scan
    }
  }

  // Recovery path: JSON truncated mid-copy (missing trailing "]}" etc.).
  const closed = closeTruncatedJson(trimmed);
  if (closed) {
    try {
      return JSON.parse(closed);
    } catch {
      // continue to balanced scan
    }
    const cs = closed.indexOf("{");
    const ce = closed.lastIndexOf("}");
    if (cs >= 0 && ce > cs) {
      try {
        return JSON.parse(closed.slice(cs, ce + 1));
      } catch {
        // continue to balanced scan
      }
    }
  }

  // Robust path: find the best balanced object (prefer resume-shaped ones).
  const objects = extractBalancedJsonObjects(trimmed);
  if (!objects.length) return null;

  const scoreObj = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return -1;
    let score = 0;
    if (Array.isArray(obj.experience)) score += 100000 + obj.experience.length * 100;
    if (Array.isArray(obj.certifications) && obj.certifications.length) {
      score += 50000;
    }
    if (typeof obj.profile === "string") score += 25000;
    if (typeof obj.name === "string") score += 1000;
    return score;
  };

  let best = null;
  let bestScore = -1;
  for (const obj of objects) {
    const s = scoreObj(obj);
    if (s > bestScore) {
      best = obj;
      bestScore = s;
    }
  }
  return best;
}

function coerceResumeObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const inner = tryParseJson(value);
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
  }
  return null;
}

export function extractResumeJson(responseText) {
  return coerceResumeObject(tryParseJson(responseText));
}

function totalExperienceBullets(data) {
  if (!Array.isArray(data?.experience)) return 0;
  return data.experience.reduce(
    (sum, job) => sum + (Array.isArray(job?.bullets) ? job.bullets.filter(Boolean).length : 0),
    0
  );
}

function countRenderableSkills(skills) {
  if (!skills) return 0;
  if (Array.isArray(skills)) {
    return skills.filter((row) => {
      if (typeof row === "string") return Boolean(row.trim());
      if (!row || typeof row !== "object") return false;
      const category = String(row.category || row.name || row.title || "").trim();
      const items = String(row.items || row.skills || row.technologies || "").trim();
      if (category || items) return true;
      return Object.values(row).some((v) => String(v || "").trim());
    }).length;
  }
  if (typeof skills === "object") {
    return Object.keys(skills).filter((k) => String(skills[k] || "").trim()).length;
  }
  return 0;
}

export function hasRenderableSkills(skills, min = 2) {
  return countRenderableSkills(skills) >= min;
}

/** Soft check: enough content to render a resume PDF. */
export function isUsableResumeJson(data) {
  if (!data || typeof data !== "object") return false;
  if (!String(data.name || "").trim()) return false;
  if (!String(data.profile || "").trim() || String(data.profile).length < 80) return false;
  // One school or an array of them — at least one needs a school name.
  if (!normalizeEducation(data.education).some((edu) => edu.school)) return false;
  if (countRenderableSkills(data.skills) < 2) return false;
  if (!Array.isArray(data.experience) || data.experience.length < 6) return false;
  return totalExperienceBullets(data) >= 18;
}

export function isCompleteResumeJson(data) {
  if (!isUsableResumeJson(data)) return false;
  if (!String(data.profile || "").trim() || String(data.profile).length < 120) return false;
  if (countRenderableSkills(data.skills) < 3) return false;
  if (totalExperienceBullets(data) < 20) return false;

  for (const rule of EXPECTED_BULLET_COUNTS) {
    const job = data.experience.find((j) => rule.match.test(String(j?.company || "").trim()));
    if (!job || !Array.isArray(job.bullets) || job.bullets.filter(Boolean).length < rule.count) {
      return false;
    }
  }

  return true;
}

export function mergeJsonFragments(parts) {
  const cleaned = parts.filter(Boolean).map(normalizeJsonText);
  let usable = null;

  for (let i = cleaned.length - 1; i >= 0; i -= 1) {
    const one = extractResumeJson(cleaned[i]);
    if (isCompleteResumeJson(one)) return one;
    if (!usable && isUsableResumeJson(one)) usable = one;
  }

  const combined = extractResumeJson(cleaned.join("\n"));
  if (isCompleteResumeJson(combined)) return combined;
  if (isUsableResumeJson(combined)) return combined;
  return usable || combined;
}

export function looksLikeAlreadyCompleteRefusal(responseText) {
  const text = String(responseText || "").toLowerCase();
  return (
    text.includes("already complete") ||
    text.includes("already closed") ||
    text.includes("nothing remaining") ||
    text.includes("nothing to continue") ||
    text.includes("can't truthfully fabricate") ||
    text.includes("cannot truthfully fabricate") ||
    (text.includes("properly closed") && text.includes("json"))
  );
}

export function resumeJsonNeedsContinuation(rawText, data) {
  // If we can render a resume, do not ask ChatGPT to continue.
  if (isUsableResumeJson(data) || isCompleteResumeJson(data)) return false;
  if (looksLikeAlreadyCompleteRefusal(rawText)) return false;

  const text = String(rawText || "").toLowerCase();
  const signals = [
    "multiple parts",
    "in multiple parts",
    "exceeds the maximum",
    "maximum single-response",
    "response size limit",
    "too large to",
    "due to length",
    "continue in the next",
    "i will continue",
    "provide it in multiple",
    "split into several",
    "part 1 of",
    "part 2 of",
    "combine the parts"
  ];
  if (signals.some((s) => text.includes(s))) return true;
  if (!data) return true;

  const trimmed = normalizeJsonText(rawText);
  if (trimmed.includes("{") && !trimmed.trim().endsWith("}")) return true;
  return !isUsableResumeJson(data);
}

export function normalizeResumePayload(data) {
  if (!data || typeof data !== "object") return data || {};
  return {
    ...data,
    experience: normalizeExperience(data.experience)
  };
}

export { resumeJsonToHtml, normalizeResumeData, markHtmlForPdf } from "./templates/index.js";
export { normalizeExperience, normalizeSkills };
