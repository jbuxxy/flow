import { cache } from "react";
// Provider-agnostic AI client — dispatches to whichever provider a
// household has configured (see /settings/ai) instead of a single global
// key. Every function here keeps the same graceful-degrade contract as the
// old Gemini-only src/lib/ai.ts: network/parse/auth failures are logged and
// swallowed, never thrown, so a caller already tolerating "no AI configured"
// doesn't need to change.

import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { isDemoHousehold } from "@/lib/demo";
import type { AiProvider } from "@prisma/client";

export type AiProviderConfig = { provider: AiProvider; apiKey: string };

export async function getHouseholdAiConfig(householdId: string): Promise<AiProviderConfig | null> {
  // The read-only example household never calls a provider — it renders
  // entirely from artifacts baked by the one-time seed pass. (Its
  // HouseholdAiSettings row is also deleted at seed finalize, so this is
  // belt-and-suspenders for the window before that.)
  if (await isDemoHousehold(householdId)) return null;
  const row = await db.householdAiSettings.findUnique({ where: { householdId } });
  if (!row) return null;
  try {
    return { provider: row.provider, apiKey: decrypt(row.apiKeyEncrypted) };
  } catch (err) {
    console.error("[ai-provider] failed to decrypt stored key:", err instanceof Error ? err.message : err);
    return null;
  }
}

// "Needs attention" for the household's AI connection — no key configured
// at all is included, not just a configured-but-broken one, matching the
// household's explicit ask for parity with the SimpleFIN badge below.
// cache(): the app shell and the dashboard both ask on the same request.
export const needsAiAttention = cache(async function needsAiAttention(householdId: string): Promise<boolean> {
  // The demo household deliberately has no AI row (cleared at seed finalize);
  // that's the intended steady state, not something for its OWNER to "fix".
  if (await isDemoHousehold(householdId)) return false;
  const row = await db.householdAiSettings.findUnique({ where: { householdId }, select: { status: true } });
  return !row || row.status === "ERROR";
});

// Best-effort — a settings row can vanish mid-flight (household just hit
// Disconnect while a sync was in-flight), which isn't itself an error worth
// logging loudly.
async function recordAiHealth(householdId: string, error: string | null): Promise<void> {
  try {
    await db.householdAiSettings.update({
      where: { householdId },
      data: { status: error ? "ERROR" : "ACTIVE", lastError: error },
    });
  } catch {
    // no-op
  }
}

// Defaults for lightweight, cost-sensitive tasks (batch categorization,
// one-sentence summaries, ballpark estimates) — not the flagship model for
// any provider. Model catalogs shift fast; this is the one place to update
// if a provider renames/retires the one below.
const DEFAULT_MODEL: Record<AiProvider, string> = {
  // gemini-2.5-flash was retired for new API keys ("no longer available to
  // new users" 404) — Google's own error points at gemini-3.6-flash.
  GEMINI: "gemini-3.6-flash",
  // Bare id, no date suffix — Anthropic's current model ids (unlike some
  // providers') are never dated (e.g. "claude-haiku-4-5", not
  // "claude-haiku-4-5-20251001"); a dated variant here was stale and would
  // eventually 404 as older snapshots roll off.
  ANTHROPIC: "claude-haiku-4-5",
  // Not independently verified against OpenAI's current model list —
  // confirm before relying on it in production.
  OPENAI: "gpt-5-mini",
  // Not independently verified against xAI's current model list — xAI has
  // been renaming/retiring models quickly, confirm before relying on it.
  GROK: "grok-4-fast",
};

const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Standard (lowercase-type) JSON Schema -> Gemini's UPPERCASE-type
// responseSchema shape. Gemini doesn't understand additionalProperties, so
// it's stripped rather than passed through.
function toGeminiSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);

  const obj = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "additionalProperties") continue;
    if (key === "type" && typeof value === "string") {
      out[key] = value.toUpperCase();
    } else if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = toGeminiSchema(propValue);
      }
      out[key] = props;
    } else if (key === "items") {
      out[key] = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function callGemini(
  apiKey: string,
  prompt: string,
  schema?: object,
): Promise<string | null> {
  const model = DEFAULT_MODEL.GEMINI;
  const generationConfig = schema
    ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(schema) }
    : undefined;

  // The header form (not `?key=` in the URL) — Google supports both, but a
  // query-string key is far more likely to end up somewhere it shouldn't:
  // access logs, an error message that echoes the request URL, a proxy's
  // own logging. Same reasoning as every other provider here using a header.
  const res = await fetch(GEMINI_ENDPOINT(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      ...(generationConfig ? { generationConfig } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini request failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" ? text : null;
}

// OpenAI and Grok (xAI) both speak the OpenAI Chat Completions shape —
// xAI's API is explicitly OpenAI-compatible at a different base URL.
async function callOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  schema?: object,
): Promise<string | null> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      ...(schema
        ? { response_format: { type: "json_schema", json_schema: { name: "result", schema, strict: true } } }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text : null;
}

// Anthropic has no native JSON-schema response mode — structured output is
// achieved via forced tool-use: the model must call the "return_result"
// tool, and its (already-parsed) input IS the result. Unlike every other
// provider here, this path does NOT need JSON.parse — the tool_use input is
// a real object already, not a text blob to parse.
async function callAnthropic(
  apiKey: string,
  prompt: string,
  schema?: object,
): Promise<string | object | null> {
  const model = DEFAULT_MODEL.ANTHROPIC;
  const body: Record<string, unknown> = {
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  };
  if (schema) {
    body.tools = [{ name: "return_result", description: "Return the result.", input_schema: schema }];
    body.tool_choice = { type: "tool", name: "return_result" };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data?.content as { type: string; text?: string; input?: object; name?: string }[] | undefined;
  if (!content) return null;

  if (schema) {
    const toolUse = content.find((block) => block.type === "tool_use" && block.name === "return_result");
    return toolUse?.input ?? null;
  }
  const textBlock = content.find((block) => block.type === "text");
  return textBlock?.text ?? null;
}

// Free-text generation — narrative feedback, one-sentence summaries.
// Records success/failure onto the household's HouseholdAiSettings row
// (status/lastError) so /settings/ai and the Settings page badge stay
// current with real usage, not just what was true at save time.
export async function callText(householdId: string, config: AiProviderConfig, prompt: string): Promise<string | null> {
  try {
    const text = await dispatch(config, prompt, undefined);
    const result = typeof text === "string" && text.trim() ? text.trim() : null;
    await recordAiHealth(householdId, result ? null : "The provider returned an empty response.");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-provider:${config.provider}] text request failed:`, message);
    await recordAiHealth(householdId, message);
    return null;
  }
}

// Structured JSON generation — bucket categorization, asset estimates.
// `schema` must be a top-level object (not array/string/etc) — required for
// Anthropic's forced-tool-use input_schema and OpenAI/Grok's strict JSON
// schema mode; Gemini's array/scalar support is translated the same way.
export async function callJson<T>(householdId: string, config: AiProviderConfig, prompt: string, schema: object): Promise<T | null> {
  try {
    const result = await dispatch(config, prompt, schema);
    if (result === null || result === undefined) {
      await recordAiHealth(householdId, "The provider returned an empty response.");
      return null;
    }
    // Anthropic returns an already-parsed object; every other provider
    // returns raw text that still needs JSON.parse.
    const parsed = typeof result === "object" ? (result as T) : (JSON.parse(result) as T);
    await recordAiHealth(householdId, null);
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-provider:${config.provider}] json request failed:`, message);
    await recordAiHealth(householdId, message);
    return null;
  }
}

// Save-time verification — a real test call, not just "something was
// typed." Returns null on success, or a human-readable error to surface in
// the save form on failure. Deliberately bypasses recordAiHealth (there's
// no persisted row yet to update at this point — saveAiSettings decides
// whether to persist at all based on this result).
export async function verifyAiConfig(config: AiProviderConfig): Promise<string | null> {
  try {
    const result = await dispatch(config, 'Reply with only the word "ok".', undefined);
    if (typeof result === "string" && result.trim()) return null;
    return "The provider returned an empty response.";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function dispatch(config: AiProviderConfig, prompt: string, schema: object | undefined) {
  switch (config.provider) {
    case "GEMINI":
      return callGemini(config.apiKey, prompt, schema);
    case "OPENAI":
      return callOpenAiCompatible("https://api.openai.com/v1", config.apiKey, DEFAULT_MODEL.OPENAI, prompt, schema);
    case "GROK":
      return callOpenAiCompatible("https://api.x.ai/v1", config.apiKey, DEFAULT_MODEL.GROK, prompt, schema);
    case "ANTHROPIC":
      return callAnthropic(config.apiKey, prompt, schema);
  }
}
