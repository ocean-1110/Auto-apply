/**
 * Drop employer-marketing, benefits, and EEO blocks from a scraped JD
 * before it is sent to the resume prompt. Falls back to the original
 * text if cleaning would remove most of the posting.
 */

const BOILERPLATE_BLOCK =
  /(equal\s+opportunity|\beeo\b|without\s+regard\s+to|protected\s+veteran|reasonable\s+accommodation|drug[-\s]free|e-verify|visa\s+sponsorship|does\s+not\s+(provide|offer)\s+sponsor|background\s+check|\bbenefits?\b|\bperks?\b|what\s+we\s+offer|401\s*\(?k\)?|paid\s+time\s+off|health,?\s*(and\s+)?dental|dental,?\s*(and\s+)?vision|^\s*about\b|who\s+we\s+are|why\s+(join|work)|our\s+(mission|culture|values|story)|diversity\s+and\s+inclusion|privacy\s+policy|how\s+to\s+apply|apply\s+now|disclaimer|staffing\s+agenc|recruit(ing|ment)\s+agenc)/im;

const REAL_SECTION =
  /(responsibilit|requirement|qualification|what\s+you.{0,4}ll\s+(do|bring)|duties|must[-\s]have|nice[-\s]to[-\s]have|day[-\s]to[-\s]day|the\s+role|job\s+description|technical\s+skills|proficien|expertise|hands[-\s]on)/i;

const BOILERPLATE_LINE =
  /(equal\s+opportunity|without\s+regard\s+to|protected\s+veteran|reasonable\s+accommodation|e-verify|visa\s+sponsorship|does\s+not\s+(provide|offer)\s+sponsor|authorized\s+to\s+work)/i;

function normalizeAtsText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyTokens(companyName) {
  return new Set(
    normalizeAtsText(companyName)
      .split(" ")
      .filter((w) => w.length > 2)
  );
}

export function cleanJdForPrompt(jdText, { companyName = "" } = {}) {
  const raw = String(jdText || "");
  if (!raw.trim()) return "";

  const kept = raw
    .split(/\n\s*\n+/)
    .filter((block) => {
      if (!block.trim()) return false;
      if (!BOILERPLATE_BLOCK.test(block)) return true;
      return REAL_SECTION.test(block);
    })
    .map((block) =>
      block
        .split(/\n/)
        .filter((line) => !BOILERPLATE_LINE.test(line))
        .join("\n")
    )
    .join("\n\n");

  let cleaned = kept.trim();
  if (cleaned.length < raw.trim().length * 0.3) {
    cleaned = raw
      .split(/\n/)
      .filter((line) => !BOILERPLATE_LINE.test(line))
      .join("\n")
      .trim();
  }

  const company = companyTokens(companyName);
  if (!company.size) return cleaned;
  return cleaned
    .split(/(\s+)/)
    .filter((chunk) => /\s/.test(chunk) || !company.has(normalizeAtsText(chunk)))
    .join("");
}
