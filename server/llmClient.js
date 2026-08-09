'use strict';

/**
 * Thin wrapper around Groq's OpenAI-compatible /chat/completions endpoint.
 *
 * Design goal: the whole interview agent must run and demo perfectly with
 * ZERO external API keys (deterministic templates take over). If a
 * GROQ_API_KEY is present, we use it to make follow-up questions and final
 * feedback feel more natural and adaptive. Every call is wrapped so a
 * network failure never breaks the interview flow.
 */

const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function isEnabled() {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {{ json?: boolean, temperature?: number, maxTokens?: number }} opts
 * @returns {Promise<string|null>} raw text content, or null if unavailable/failed
 */
async function chatComplete(messages, opts = {}) {
  if (!isEnabled()) return null;

  const body = {
    model: GROQ_MODEL,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 500
  };

  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[llmClient] Groq API responded ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn('[llmClient] Groq API call failed, falling back to templates:', err.message);
    return null;
  }
}

/** Attempts to parse JSON out of an LLM response, stripping code fences if present. */
function safeParseJson(text) {
  if (!text) return null;
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

module.exports = { chatComplete, safeParseJson, isEnabled };
