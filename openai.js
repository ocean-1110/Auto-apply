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
    supportsTemperature: !reasoning
  };
  modelQuirks.set(key, quirks);
  return quirks;
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

  const buildBody = () => {
    const quirks = quirksFor(modelName);
    const next = {
      model: modelName,
      messages,
      [quirks.tokenParam]: maxTokens
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

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    // On reasoning models the token budget covers hidden reasoning too, so a
    // model can spend the whole allowance before writing a single visible
    // character. "Empty response" hides that; say what actually happened.
    if (choice?.finish_reason === "length") {
      throw new Error(
        `OpenAI returned no content: ${modelName} used its entire ${maxTokens}-token budget before answering. Raise the token limit or use a non-reasoning model for this call.`
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

export const RESUME_JSON_SYSTEM_PROMPT = `You generate tailored technical resumes as a single valid JSON object only — no markdown fences, no commentary.

LENGTH AND COMPLETENESS — CRITICAL (API responses tend to undershoot; do not):
- Produce a FULL-LENGTH resume comparable to a strong ChatGPT web reply. Never abbreviate to save tokens.
- skills: include ALL relevant categories from the user prompt (typically 6–9+). Each "items" string must be dense with many technologies/tools (comma-separated), not a short handful.
- experience: include EVERY required job with the EXACT bullet counts from the user prompt. Do not drop jobs or bullets.
- Each experience entry MUST include company, location, title, dates, and a bullets array. Never omit the company name.
- Each experience bullet must be ONE long sentence (~170–240 characters), describing concrete implementation work with technologies and impact — not short vague lines.
- profile: 5–7 full sentences as specified in the user prompt.
- certifications: include every certification listed in the user prompt, verbatim. If the prompt lists none, return an empty array (do not invent any).
- Finish the entire JSON object in one reply. Do not shorten skills or experience because of length.`;
