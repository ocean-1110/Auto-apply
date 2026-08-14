/**
 * Lightweight LLM cost + fill-source tracking for one job session.
 * Actual USD uses gpt-4o-mini (or the model that ran). Legacy USD prices the
 * same tokens as gpt-4o with the old 2-pass + full JD/resume autofill path.
 */

const SESSION_KEY = "llm_cost_session";

/** USD per 1M tokens. */
const PRICES = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 }
};

const LEGACY_MODEL = "gpt-4o";
const EXTRA_CONTEXT_TOKENS = 1750;

function priceFor(model) {
  const key = String(model || "").toLowerCase();
  if (PRICES[key]) return PRICES[key];
  if (key.includes("mini")) return PRICES["gpt-4o-mini"];
  if (key.includes("gpt-4o")) return PRICES["gpt-4o"];
  return PRICES["gpt-4o-mini"];
}

export function usdForTokens(model, inputTokens, outputTokens) {
  const p = priceFor(model);
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return (input * p.input + output * p.output) / 1_000_000;
}

function emptySession(jobKey = "") {
  return {
    jobKey: String(jobKey || ""),
    startedAt: Date.now(),
    profileHits: 0,
    bankHits: 0,
    aiCalls: 0,
    aiAnswers: 0,
    actualUsd: 0,
    legacyUsd: 0,
    calls: []
  };
}

export async function ensureCostSession(jobKey = "") {
  const data = await chrome.storage.local.get(SESSION_KEY);
  const cur = data[SESSION_KEY];
  const key = String(jobKey || "");
  const fresh =
    !cur ||
    (key && cur.jobKey && cur.jobKey !== key) ||
    Date.now() - Number(cur.startedAt || 0) > 45 * 60 * 1000;
  if (!fresh) {
    if (key && !cur.jobKey) {
      cur.jobKey = key;
      await chrome.storage.local.set({ [SESSION_KEY]: cur });
    }
    return cur;
  }
  const session = emptySession(key);
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export async function getCostSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY] || emptySession();
}

function legacyUsdForCall(purpose, inputTokens, outputTokens) {
  let inTok = Math.max(0, Number(inputTokens) || 0);
  let outTok = Math.max(0, Number(outputTokens) || 0);
  let copies = 1;
  if (purpose === "autofill_text") {
    copies = 2;
    inTok += EXTRA_CONTEXT_TOKENS;
  } else if (purpose === "autofill_choice") {
    inTok += EXTRA_CONTEXT_TOKENS;
  }
  return usdForTokens(LEGACY_MODEL, inTok * copies, outTok * copies);
}

export async function logLlmCall({
  purpose = "",
  model = "gpt-4o-mini",
  inputTokens = 0,
  outputTokens = 0
} = {}) {
  const session = await ensureCostSession();
  const actual = usdForTokens(model, inputTokens, outputTokens);
  const legacy = legacyUsdForCall(purpose, inputTokens, outputTokens);
  session.aiCalls += 1;
  session.actualUsd += actual;
  session.legacyUsd += legacy;
  session.calls.push({
    ts: Date.now(),
    purpose,
    model,
    inputTokens: Number(inputTokens) || 0,
    outputTokens: Number(outputTokens) || 0,
    actualUsd: actual,
    legacyUsd: legacy
  });
  if (session.calls.length > 40) session.calls = session.calls.slice(-40);
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export async function logFillHits({
  profileHits = 0,
  bankHits = 0,
  aiAnswers = 0
} = {}) {
  const session = await ensureCostSession();
  session.profileHits += Number(profileHits) || 0;
  session.bankHits += Number(bankHits) || 0;
  session.aiAnswers += Number(aiAnswers) || 0;
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export function formatUsd(n) {
  const v = Number(n) || 0;
  if (v < 0.0005) return "$0";
  if (v < 0.01) return `~$${v.toFixed(4)}`;
  return `~$${v.toFixed(3)}`;
}

export function formatCostSummary(session) {
  if (!session) return "";
  const saved = Math.max(0, Number(session.legacyUsd || 0) - Number(session.actualUsd || 0));
  const fill =
    `Filled ${session.profileHits || 0} from profile, ` +
    `${session.bankHits || 0} from Q&A bank, ` +
    `${session.aiAnswers || 0} via AI.`;
  return (
    `${fill} This job ${formatUsd(session.actualUsd)} ` +
    `(legacy ${formatUsd(session.legacyUsd)}, saved ${formatUsd(saved)}).`
  );
}

export async function getCostSummaryText() {
  const session = await getCostSession();
  return formatCostSummary(session);
}
