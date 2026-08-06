/**
 * CSV parsing + normalization for imported job applications.
 *
 * Requirements:
 * - RFC4180-style quoted fields (commas/newlines inside quotes).
 * - Escaped quotes as "" within quoted fields.
 * - UTF-8 text (the file may include a BOM).
 */

function stripBom(s) {
  return String(s || "").replace(/^\uFEFF/, "");
}

/**
 * Parse a CSV string into an array of rows (each row is an array of fields).
 * Minimal RFC4180 implementation: handles quotes, escaped quotes, and newlines inside quotes.
 */
export function parseCsvRfc(text) {
  const input = stripBom(text);
  const rows = [];

  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = input[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }

      field += ch;
      i += 1;
      continue;
    }

    // Not in quotes
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (ch === "\r") {
      // Windows newline: \r\n
      if (input[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // Flush tail
  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);

  // Remove trailing empty rows (common when the file ends with a newline).
  while (rows.length && rows[rows.length - 1].every((c) => String(c || "").trim() === "")) {
    rows.pop();
  }

  return rows;
}

function headerNormalize(s) {
  return String(s || "").trim();
}

function fieldByHeader(row, headers, key) {
  const idx = headers.indexOf(key);
  if (idx === -1) return "";
  return String(row[idx] ?? "");
}

export function isLinkedInSource(source) {
  return String(source || "").trim().toLowerCase() === "linkedin";
}

function buildJdText({ description, keySkills, prependKeySkills }) {
  const jd = String(description || "").trim();
  const skills = String(keySkills || "").trim();

  if (!prependKeySkills) return jd;
  if (!skills) return jd;

  return `Key skills:\n${skills}\n\n${jd}`;
}

/**
 * @param {string} csvText
 * @returns {{
 *  jobs: Array<{id:string, jobTitle:string, companyName:string, jdLink:string, keySkills:string, jdText:string, source:string, description:string}>,
 *  skipped: number,
 *  imported: number,
 *  errors: Array<{rowIndex:number, message:string}>
 * }}
 */
export function parseImportedJobsCsvText(csvText) {
  const rows = parseCsvRfc(csvText);
  if (!rows.length) {
    return { jobs: [], skipped: 0, imported: 0, errors: [{ rowIndex: 0, message: "CSV is empty." }] };
  }

  const headers = rows[0].map(headerNormalize);
  const headerSet = new Set(headers);

  const required = ["id", "title", "organization", "key_skills", "source", "url", "description"];
  const missing = required.filter((h) => !headerSet.has(h));
  if (missing.length) {
    return {
      jobs: [],
      skipped: 0,
      imported: 0,
      errors: [{ rowIndex: 0, message: `CSV missing required header(s): ${missing.join(", ")}` }]
    };
  }

  const jobs = [];
  const errors = [];
  let skipped = 0;

  // Rows start at 1 (after headers)
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || [];

    const id = fieldByHeader(row, headers, "id").trim();
    const title = fieldByHeader(row, headers, "title").trim();
    const organization = fieldByHeader(row, headers, "organization").trim();
    const keySkills = fieldByHeader(row, headers, "key_skills").trim();
    const source = fieldByHeader(row, headers, "source").trim();
    const jdLink = fieldByHeader(row, headers, "url").trim();
    const description = fieldByHeader(row, headers, "description");

    if (!id || !title || !organization || !jdLink || !description) {
      skipped += 1;
      continue;
    }

    // “prependKeySkills” is the behavior selected for this project.
    const jdText = buildJdText({ description, keySkills, prependKeySkills: true });

    jobs.push({
      id,
      jobTitle: title,
      companyName: organization,
      jdLink,
      keySkills,
      jdText,
      source,
      description: String(description || "")
    });
  }

  return { jobs, skipped, imported: jobs.length, errors };
}

