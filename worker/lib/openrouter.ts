/**
 * OpenRouter AI Agent Integration Service
 *
 * Manages connecting, storing, and testing OpenRouter API keys
 * and default model preferences for AI agents.
 */

import { getSetting, setSetting } from "./settings";
import { now } from "./util";

export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-3.5-sonnet";

export interface OpenRouterConfig {
  apiKey: string;
  defaultModel?: string;
  updatedAt?: number;
}

export interface OpenRouterConfigDTO {
  configured: boolean;
  defaultModel: string;
  maskedKey: string | null;
  updatedAt: number | null;
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 10) return "••••••••";
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

/**
 * Retrieves the stored OpenRouter configuration.
 */
export async function getOpenRouterConfig(db: D1Database): Promise<OpenRouterConfig | null> {
  const raw = await getSetting(db, "openrouter_config");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OpenRouterConfig;
  } catch {
    return null;
  }
}

/**
 * Returns safe DTO with masked key for client display.
 */
export async function getOpenRouterConfigDTO(db: D1Database): Promise<OpenRouterConfigDTO> {
  const conf = await getOpenRouterConfig(db);
  if (!conf || !conf.apiKey) {
    return {
      configured: false,
      defaultModel: DEFAULT_OPENROUTER_MODEL,
      maskedKey: null,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    defaultModel: conf.defaultModel || DEFAULT_OPENROUTER_MODEL,
    maskedKey: maskApiKey(conf.apiKey),
    updatedAt: conf.updatedAt ?? null,
  };
}

/**
 * Saves OpenRouter configuration in D1 settings.
 */
export async function saveOpenRouterConfig(
  db: D1Database,
  input: { apiKey: string; defaultModel?: string }
): Promise<OpenRouterConfigDTO> {
  const trimmedKey = input.apiKey?.trim();
  if (!trimmedKey) {
    throw new Error("OpenRouter API key is required");
  }

  const model = input.defaultModel?.trim() || DEFAULT_OPENROUTER_MODEL;
  const config: OpenRouterConfig = {
    apiKey: trimmedKey,
    defaultModel: model,
    updatedAt: now(),
  };

  await setSetting(db, "openrouter_config", JSON.stringify(config));
  return getOpenRouterConfigDTO(db);
}

/**
 * Deletes OpenRouter configuration.
 */
export async function deleteOpenRouterConfig(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = 'openrouter_config'").run();
}

/**
 * Tests an OpenRouter API key against OpenRouter's auth check endpoint.
 */
export async function testOpenRouterKey(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  message: string;
  label?: string;
  usage?: number;
  limit?: number;
}> {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return { ok: false, message: "OpenRouter API key is required" };
  }

  try {
    const res = await fetchFn("https://openrouter.ai/api/v1/auth/key", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401) {
      return { ok: false, message: "Invalid OpenRouter API Key (401 Unauthorized)" };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, message: `OpenRouter returned HTTP ${res.status}: ${text || res.statusText}` };
    }

    const data = await res.json().catch(() => ({})) as any;
    const keyData = data?.data || {};

    return {
      ok: true,
      message: "Successfully connected to OpenRouter!",
      label: keyData.label || "Personal API Key",
      usage: typeof keyData.usage === "number" ? keyData.usage : undefined,
      limit: typeof keyData.limit === "number" ? keyData.limit : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
