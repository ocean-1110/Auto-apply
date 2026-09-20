export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export function estimateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

export function estimateTokensFromMessages(messages = []) {
  return (messages || []).reduce(
    (n, m) => n + estimateTokensFromText(m?.content),
    0
  );
}

/** Large enough for full resume JSON (6 jobs, dense skills, long bullets). */
const DEFAULT_MAX_TOKENS = 16384;

/** Floor for reasoning models, whose hidden reasoning shares the same budget. */
const REASONING_MIN_TOKENS = 4000;

/** Never ask for more than the resume-sized budget, even when growing one. */
const MAX_TOKEN_CEILING = 16384;

/**
 * Call OpenAI Chat Completions. Used only from the background service worker.
 */
/** Optional AbortSignal used by in-flight generation (set from the service worker). */
let activeChatAbortSignal = null;

export function setChatAbortSignal(signal = null) {
  activeChatAbortSignal = signal || null;
}

/* ------------------------------------------------------------------------- *
 * Per-model request quirks
 *
 * Chat Completions is not uniform across models. The reasoning families
 * (o-series, GPT-5) rejected the classic `max_tokens` in favour of
 * `max_completion_tokens`, and they only accept the default temperature:
 *
 *   HTTP 400 — Unsupported parameter: 'max_tokens' is not supported with this
 *   model. Use 'max_completion_tokens' instead.
 *
 * A hard-coded model list goes stale every time OpenAI ships a name we have
 * never seen, so the name only seeds a guess — the first 400 corrects it, and
 * the correction is cached for the rest of the service-worker's life so the
 * extra round-trip is paid once, not per call.
 * ------------------------------------------------------------------------- */

const modelQuirks = new Map();

function quirksFor(model) {
  const key = String(model || "").toLowerCase();
  const cached = modelQuirks.get(key);
  if (cached) return cached;
  // o1/o3/o4…, gpt-5* and anything tagged "reasoning" default to the new shape.
  const reasoning = /^(o\d|gpt-5|gpt5)/.test(key) || /reasoning/.test(key);
  const quirks = {
    tokenParam: reasoning ? "max_completion_tokens" : "max_tokens",
    supportsTemperature: !reasoning,
    reasoning,
    minTokens: reasoning ? REASONING_MIN_TOKENS : 0
  };
  modelQuirks.set(key, quirks);
  return quirks;
}

/**
 * On a reasoning model the token cap pays for hidden reasoning as well as the
 * visible answer, so a budget sized for the answer alone can be spent before a
 * single character is written — the request then returns finish_reason "length"
 * with empty content. Small caller budgets get a floor on those models; a
 * non-reasoning model keeps exactly what the caller asked for.
 */
function effectiveMaxTokens(quirks, requested) {
  const asked = Math.max(1, Number(requested) || DEFAULT_MAX_TOKENS);
  if (!quirks.reasoning) return asked;
  return Math.min(MAX_TOKEN_CEILING, Math.max(asked, quirks.minTokens || REASONING_MIN_TOKENS));
}

/**
 * Read a rejected-parameter 400 and adjust this model's quirks.
 * @returns {boolean} true when something changed and the call is worth retrying
 */
function learnFromParameterError(model, apiMessage) {
  const msg = String(apiMessage || "");
  if (!msg) return false;
  const quirks = quirksFor(model);
  let changed = false;

  if (/max_completion_tokens/i.test(msg) && quirks.tokenParam !== "max_completion_tokens") {
    quirks.tokenParam = "max_completion_tokens";
    changed = true;
  } else if (
    /'max_completion_tokens'\s+is not supported/i.test(msg) &&
    quirks.tokenParam !== "max_tokens"
  ) {
    quirks.tokenParam = "max_tokens";
    changed = true;
  }

  if (
    quirks.supportsTemperature &&
    /temperature/i.test(msg) &&
    /(unsupported|not supported|does not support|only the default)/i.test(msg)
  ) {
    quirks.supportsTemperature = false;
    changed = true;
  }

  if (changed) modelQuirks.set(String(model || "").toLowerCase(), quirks);
  return changed;
}

export async function chatCompletion({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  messages,
  jsonMode = false,
  temperature = 0.4,
  maxTokens = DEFAULT_MAX_TOKENS,
  signal = null
}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error(
      "OpenAI API key is missing. Add OPENAI_API_KEY to the extension .env file, then reload the extension."
    );  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("OpenAI messages are required.");
  }

  const modelName = String(model || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
  const abortSignal = signal || activeChatAbortSignal || undefined;
  const delaysMs = [2000, 4000];

  // The budget actually sent, which may be larger than the caller's request.
  let sentMaxTokens = maxTokens;

  const buildBody = () => {
    const quirks = quirksFor(modelName);
    sentMaxTokens = effectiveMaxTokens(quirks, maxTokens);
    const next = {
      model: modelName,
      messages,
      [quirks.tokenParam]: sentMaxTokens
    };
    if (quirks.supportsTemperature) next.temperature = temperature;
    if (jsonMode) next.response_format = { type: "json_object" };
    return next;
  };

  /** One request with the existing network-error retry/backoff. */
  const send = async (body) => {
    let response;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          ...(abortSignal ? { signal: abortSignal } : null)
        });
        lastErr = null;
        break;
      } catch (err) {
        if (
          err?.name === "AbortError" ||
          abortSignal?.aborted ||
          /aborted|abort/i.test(String(err?.message || ""))
        ) {
          throw new Error("Generation cancelled by user.");
        }
        lastErr = err;
        if (attempt >= 3) {
          throw new Error(`OpenAI request failed: ${String(err?.message || err)}`);
        }
        const waitEnd = Date.now() + (delaysMs[attempt - 1] || 3000);
        while (Date.now() < waitEnd) {
          if (abortSignal?.aborted) throw new Error("Generation cancelled by user.");
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    if (!response) {
      throw new Error(
        `OpenAI request failed: ${String(lastErr?.message || lastErr || "network error")}`
      );
    }
    const rawText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }
    return { response, rawText, payload };
  };

  let response;
  let rawText;
  let payload;
  // Two extra passes at most: one to fix the token parameter, one for temperature.
  for (let pass = 0; pass < 3; pass += 1) {
    ({ response, rawText, payload } = await send(buildBody()));
    if (response.ok || response.status !== 400) break;
    const apiMessage = payload?.error?.message || rawText.slice(0, 200);
    if (!learnFromParameterError(modelName, apiMessage)) break;
  }

  if (!response.ok) {
    const apiMessage = payload?.error?.message || rawText.slice(0, 200);
    if (response.status === 401) {
      throw new Error("OpenAI API key is invalid or revoked (401).");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new Error(
        `OpenAI ${response.status === 429 ? "rate limit" : "server"} error (HTTP ${response.status}): ${apiMessage}`
      );
    }
    throw new Error(`OpenAI error (HTTP ${response.status}): ${apiMessage}`);
  }

  let choice = payload?.choices?.[0];
  let content = choice?.message?.content;

  // Budget spent entirely on hidden reasoning: no visible characters at all.
  // Rather than failing the whole step, remember that this model needs more room
  // and ask once more with a bigger allowance. The correction is cached for the
  // life of the service worker, so the extra round-trip is paid once per model.
  if ((typeof content !== "string" || !content.trim()) && choice?.finish_reason === "length") {
    const quirks = quirksFor(modelName);
    const grown = Math.min(
      MAX_TOKEN_CEILING,
      Math.max(sentMaxTokens * 4, REASONING_MIN_TOKENS)
    );
    if (grown > sentMaxTokens) {
      quirks.reasoning = true;
      quirks.minTokens = grown;
      modelQuirks.set(modelName.toLowerCase(), quirks);
      const retry = await send(buildBody());
      const retryChoice = retry.payload?.choices?.[0];
      const retryContent = retryChoice?.message?.content;
      if (retry.response.ok && typeof retryContent === "string" && retryContent.trim()) {
        choice = retryChoice;
        content = retryContent;
        payload = retry.payload;
      } else if (retryChoice) {
        choice = retryChoice;
      }
    }
  }

  if (typeof content !== "string" || !content.trim()) {
    if (choice?.finish_reason === "length") {
      throw new Error(
        `OpenAI returned no content: ${modelName} spent its entire ${sentMaxTokens}-token budget on reasoning before answering. Pick a non-reasoning model for this call, or raise the limit.`
      );
    }
    throw new Error("OpenAI returned an empty response.");
  }
  const usageRaw = payload?.usage || {};
  const promptTokens =
    Number(usageRaw.prompt_tokens) || estimateTokensFromMessages(messages);
  const completionTokens =
    Number(usageRaw.completion_tokens) || estimateTokensFromText(content);
  return {
    content: content.trim(),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usageRaw.total_tokens) || promptTokens + completionTokens,
      estimated: !usageRaw.prompt_tokens
    }
  };
}

/**
 * The JSON object inside a model reply. JSON mode usually returns clean JSON,
 * but a stray preface or code fence would otherwise fail the whole step.
 * @returns {object | null}
 */
export function parseJsonReply(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const RESUME_JSON_SYSTEM_PROMPT = `You generate tailored technical resumes as a single valid JSON object only — no markdown fences, no commentary.

LENGTH AND COMPLETENESS — CRITICAL (API responses tend to undershoot; do not):
- Produce a FULL-LENGTH resume comparable to a strong ChatGPT web reply. Never abbreviate to save tokens.
- skills: include ALL relevant categories from the user prompt (typically 6–9+). Each "items" string must be dense with many technologies/tools (comma-separated), not a short handful.
- experience: include EVERY required job with the EXACT bullet counts from the user prompt. Do not drop jobs or bullets.
- Each experience entry MUST include company, location, title, dates, and a bullets array. Never omit the company name.
- Each experience bullet must be ONE long sentence (~170–240 characters), describing concrete implementation work with technologies and impact — not short vague lines.
- profile: 5–7 full sentences as specified in the user prompt.
- certifications: include every certification listed in the user prompt, verbatim. If the prompt lists none, return an empty array (do not invent any).
- education: use the schools from the user prompt exactly. When it lists more than one school, return "education" as an ARRAY of { school, degree, year } objects, one per school, newest first — never merge two schools into one entry or drop one.
- Finish the entire JSON object in one reply. Do not shorten skills or experience because of length.`;
