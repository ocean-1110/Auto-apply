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
export async function chatCompletion({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  messages,
  jsonMode = false,
  temperature = 0.4,
  maxTokens = DEFAULT_MAX_TOKENS
}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error(
      "OpenAI API key is missing. Add OPENAI_API_KEY to the extension .env file, then reload the extension."
    );  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("OpenAI messages are required.");
  }

  const body = {
    model: String(model || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error(`OpenAI request failed: ${String(err?.message || err)}`);
  }

  let payload = null;
  const rawText = await response.text();
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiMessage = payload?.error?.message || rawText.slice(0, 200);
    if (response.status === 401) {
      throw new Error("OpenAI API key is invalid or revoked (401).");
    }
    if (response.status === 429) {
      throw new Error(`OpenAI rate limit exceeded (429): ${apiMessage}`);
    }
    throw new Error(`OpenAI error (HTTP ${response.status}): ${apiMessage}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
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
- Each experience bullet must be ONE long sentence (~170–240 characters), describing concrete implementation work with technologies and impact — not short vague lines.
- profile: 5–7 full sentences as specified in the user prompt.
- certifications: include every certification listed in the user prompt, verbatim.
- Finish the entire JSON object in one reply. Do not shorten skills or experience because of length.`;
