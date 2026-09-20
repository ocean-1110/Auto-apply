/**
 * Load KEY=VALUE pairs from the extension's `.env` file.
 * Create `.env` next to manifest.json (see `.env.example`). Never commit real keys.
 */

let cachedEnv = null;

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function loadEnv({ force = false } = {}) {
  if (cachedEnv && !force) return cachedEnv;

  try {
    const response = await fetch(chrome.runtime.getURL(".env"));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    cachedEnv = parseEnvText(await response.text());
  } catch {
    cachedEnv = {};
  }
  return cachedEnv;
}

export async function getEnv(key, fallback = "") {
  const env = await loadEnv();
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
