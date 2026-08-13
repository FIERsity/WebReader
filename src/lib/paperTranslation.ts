import type {
  PaperTranslationProviderConfig, PaperTranslationProviderId, PaperTranslationUnit,
  TranslationTargetLanguage,
} from "../types/translation";
import { hashText } from "./translation";

export const PAPER_TRANSLATION_PROMPT_VERSION = "paper-v1";
export const MAX_PAPER_BATCH_CHARACTERS = 6_000;
export const MAX_PAPER_BATCH_UNITS = 12;
const MAX_PROVIDER_OUTPUT_TOKENS = 8_192;

export interface PaperTranslationBatchInput {
  id: string;
  ordinal: number;
  units: PaperTranslationUnit[];
}

export interface PaperTranslationProgress {
  completedBatches: number;
  totalBatches: number;
  completedUnits: number;
  totalUnits: number;
}

export interface PaperTranslationError extends Error {
  code: "auth" | "rate-limit" | "cors" | "timeout" | "transient" | "invalid-output" | "provider" | "cancelled";
  retryAfterMs?: number;
}

interface ProtectedUnit {
  id: string;
  text: string;
  kind: string;
  section?: string;
  placeholders: Map<string, string>;
}

const PROTECTED_PATTERN = /(https?:\/\/\S+|doi:\s*\S+|10\.\d{4,9}\/[-._;()/:A-Z0-9]+|\[[0-9,;\-– ]+\]|\([A-Z][A-Za-z-]+(?: et al\.)?,? \d{4}[a-z]?\)|\b(?:Fig\.|Figure|Table|Eq\.)\s*\d+[A-Za-z]?|\b[A-Za-z]+_[A-Za-z0-9]+\b)/giu;

const PAPER_ERROR_CODES = new Set<PaperTranslationError["code"]>([
  "auth", "rate-limit", "cors", "timeout", "transient", "invalid-output", "provider", "cancelled",
]);

function isPaperTranslationError(value: unknown): value is PaperTranslationError {
  return value instanceof Error && PAPER_ERROR_CODES.has((value as PaperTranslationError).code);
}

function providerError(code: PaperTranslationError["code"], message: string, retryAfterMs?: number): PaperTranslationError {
  const error = new Error(message) as PaperTranslationError;
  error.code = code;
  error.retryAfterMs = retryAfterMs;
  return error;
}

export const DEEPSEEK_PAPER_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;
export const DEFAULT_DEEPSEEK_PAPER_MODEL = DEEPSEEK_PAPER_MODELS[0];

export function isRetiredPaperModel(provider: PaperTranslationProviderId, model: string): boolean {
  return provider === "deepseek" && (model === "deepseek-chat" || model === "deepseek-reasoner");
}

export function providerDefaultEndpoint(provider: PaperTranslationProviderId): string {
  if (provider === "openai") return "https://api.openai.com/v1/responses";
  if (provider === "anthropic") return "https://api.anthropic.com/v1/messages";
  if (provider === "deepseek") return "https://api.deepseek.com/chat/completions";
  return "";
}

export function validatePaperProviderConfig(config: PaperTranslationProviderConfig): URL {
  if (!config.apiKey.trim()) throw providerError("auth", "API key is required.");
  if (!config.model.trim()) throw providerError("provider", "Model is required.");
  if (isRetiredPaperModel(config.provider, config.model.trim())) {
    throw providerError("provider", "This DeepSeek model has retired. Choose deepseek-v4-pro or deepseek-v4-flash.");
  }
  const endpoint = config.endpoint?.trim() || providerDefaultEndpoint(config.provider);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw providerError("provider", "The API endpoint is invalid.");
  }
  if (url.protocol !== "https:") throw providerError("provider", "The API endpoint must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw providerError("provider", "The API endpoint cannot contain credentials, query parameters, or a fragment.");
  }
  if (config.provider !== "custom-openai" && endpoint !== providerDefaultEndpoint(config.provider)) {
    throw providerError("provider", "Preset provider endpoints cannot be changed.");
  }
  return url;
}

function protectUnit(unit: PaperTranslationUnit): ProtectedUnit {
  const placeholders = new Map<string, string>();
  let index = 0;
  const text = unit.text.replace(PROTECTED_PATTERN, (value) => {
    const identity = unit.id.replace(/[^A-Za-z0-9]/gu, "").slice(-10) || "unit";
    let placeholder = `__WRP_${identity}_${index}__`;
    while (unit.text.includes(placeholder)) placeholder = `_${placeholder}_`;
    index += 1;
    placeholders.set(placeholder, value);
    return placeholder;
  });
  return { ...unit, text, placeholders };
}

function restoreUnit(unit: ProtectedUnit, translatedText: string): string {
  let restored = translatedText.trim();
  const expectedTokens = [...unit.placeholders.keys()].sort();
  const returnedTokens = restored.match(/_+WRP_[A-Za-z0-9]+_[0-9]+_+/gu)?.sort() ?? [];
  if (returnedTokens.length !== expectedTokens.length
    || returnedTokens.some((token, index) => token !== expectedTokens[index])) {
    throw providerError("invalid-output", `Protected content was changed for ${unit.id}.`);
  }
  for (const [placeholder, source] of unit.placeholders) restored = restored.replace(placeholder, source);
  return restored;
}

export function createPaperBatches(units: PaperTranslationUnit[]): PaperTranslationBatchInput[] {
  const batches: PaperTranslationBatchInput[] = [];
  let current: PaperTranslationUnit[] = [];
  let characters = 0;
  for (const unit of units) {
    if (unit.text.length > MAX_PAPER_BATCH_CHARACTERS) {
      throw providerError("provider", `Translation unit ${unit.id} exceeds the batch limit.`);
    }
    const nextCharacters = characters + unit.text.length;
    if (current.length > 0 && (current.length >= MAX_PAPER_BATCH_UNITS || nextCharacters > MAX_PAPER_BATCH_CHARACTERS)) {
      batches.push({ id: `batch-${batches.length + 1}`, ordinal: batches.length, units: current });
      current = [];
      characters = 0;
    }
    current.push(unit);
    characters += unit.text.length;
  }
  if (current.length > 0) batches.push({ id: `batch-${batches.length + 1}`, ordinal: batches.length, units: current });
  return batches;
}

export async function paperManifestHash(units: PaperTranslationUnit[]): Promise<string> {
  return hashText(`${PAPER_TRANSLATION_PROMPT_VERSION}\n${units.map((unit) => `${unit.id}\u0000${unit.kind}\u0000${unit.text}`).join("\n")}`);
}

function systemPrompt(targetLanguage: TranslationTargetLanguage): string {
  const target = targetLanguage === "zh-CN" ? "Simplified Chinese" : "English";
  return [
    `Translate an academic paper into ${target}.`,
    "Use precise terminology suitable for the paper's field and keep terminology consistent across units.",
    "Return every input id exactly once. Never merge, omit, split, or reorder units.",
    "Preserve every ASCII token shaped like __WRP_...__ character-for-character, exactly once.",
    "Do not translate equations, URLs, DOI strings, citation labels, variable names, or bibliography entries.",
    "Return JSON only: {\"units\":[{\"id\":\"...\",\"text\":\"...\"}]}",
  ].join(" ");
}

function batchPayload(units: ProtectedUnit[], context: string): string {
  return JSON.stringify({ context, units: units.map(({ id, text, kind, section }) => ({ id, text, kind, section })) });
}

function parseJsonObjects(value: string): unknown[] {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try { return [JSON.parse(trimmed)]; } catch {
    const starts: number[] = [];
    const candidates: unknown[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") {
        quoted = true;
        continue;
      }
      if (character === "{") starts.push(index);
      else if (character === "}" && starts.length > 0) {
        const start = starts.pop()!;
        try { candidates.push(JSON.parse(trimmed.slice(start, index + 1))); } catch { /* scan the remaining candidates */ }
      }
    }
    if (candidates.length > 0) return candidates;
    throw providerError("invalid-output", "The provider did not return valid JSON.");
  }
}

function validateUnits(value: unknown, expected: ProtectedUnit[]): Map<string, string> {
  const units = (value as { units?: unknown })?.units;
  if (!Array.isArray(units)) throw providerError("invalid-output", "The provider response has no units array.");
  const expectedById = new Map(expected.map((unit) => [unit.id, unit]));
  const output = new Map<string, string>();
  for (const entry of units) {
    const id = (entry as { id?: unknown })?.id;
    const text = (entry as { text?: unknown })?.text;
    if (typeof id !== "string" || typeof text !== "string" || !text.trim() || !expectedById.has(id) || output.has(id)) {
      throw providerError("invalid-output", "The provider returned an unknown, duplicate, or empty unit.");
    }
    output.set(id, restoreUnit(expectedById.get(id)!, text));
  }
  if (output.size !== expected.length) throw providerError("invalid-output", "The provider omitted translation units.");
  return output;
}

function validateResponse(candidates: unknown[], expected: ProtectedUnit[]): Map<string, string> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try { return validateUnits(candidate, expected); } catch (reason) {
      if (!isPaperTranslationError(reason) || reason.code !== "invalid-output") throw reason;
      lastError = reason;
    }
  }
  throw lastError ?? providerError("invalid-output", "The provider response has no valid translation object.");
}

function classifyHttpError(response: Response): PaperTranslationError {
  if (response.status === 401 || response.status === 403) return providerError("auth", "The provider rejected the API key.");
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return providerError("rate-limit", "The provider rate limit was reached.", Number.isFinite(seconds) ? seconds * 1000 : undefined);
  }
  if (response.status >= 500) return providerError("transient", `The provider returned HTTP ${response.status}.`);
  return providerError("provider", `The provider returned HTTP ${response.status}.`);
}

async function providerFetch(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    const response = await fetch(url, { ...init, signal: requestSignal, cache: "no-store", redirect: "error" });
    if (!response.ok) throw classifyHttpError(response);
    return response;
  } catch (reason) {
    if ((reason as { name?: string })?.name === "AbortError") throw providerError("cancelled", "Translation was cancelled.");
    if ((reason as { name?: string })?.name === "TimeoutError") throw providerError("timeout", "The provider request timed out.");
    if (isPaperTranslationError(reason)) throw reason;
    throw providerError("cors", "The browser could not reach this endpoint. Check provider CORS support and the endpoint host.");
  }
}

export async function translatePaperBatchDirect(input: {
  config: PaperTranslationProviderConfig;
  targetLanguage: TranslationTargetLanguage;
  units: PaperTranslationUnit[];
  context: string;
  signal: AbortSignal;
}): Promise<Map<string, string>> {
  const { config, targetLanguage, context, signal } = input;
  const url = validatePaperProviderConfig(config);
  const units = input.units.map(protectUnit);
  const prompt = systemPrompt(targetLanguage);
  const content = batchPayload(units, context);
  let response: Response;
  let candidates: unknown[];
  if (config.provider === "openai") {
    response = await providerFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model, instructions: prompt, input: content,
        max_output_tokens: MAX_PROVIDER_OUTPUT_TOKENS,
        text: { format: { type: "json_object" } },
      }),
    }, signal);
    const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    candidates = parseJsonObjects(body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text ?? "");
  } else if (config.provider === "anthropic") {
    response = await providerFetch(url, {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey, "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true", "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.model, max_tokens: MAX_PROVIDER_OUTPUT_TOKENS, system: prompt, messages: [{ role: "user", content }] }),
    }, signal);
    const body = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    candidates = parseJsonObjects(body.content?.find((item) => item.type === "text")?.text ?? "");
  } else {
    response = await providerFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "system", content: prompt }, { role: "user", content }],
        response_format: { type: "json_object" }, temperature: 0.1,
        ...(config.provider === "deepseek" ? {
          max_tokens: MAX_PROVIDER_OUTPUT_TOKENS,
          thinking: { type: "disabled" },
        } : {}),
      }),
    }, signal);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    candidates = parseJsonObjects(body.choices?.[0]?.message?.content ?? "");
  }
  return validateResponse(candidates, units);
}

export type PaperBatchTranslator = (input: {
  config: PaperTranslationProviderConfig;
  targetLanguage: TranslationTargetLanguage;
  units: PaperTranslationUnit[];
  context: string;
  signal: AbortSignal;
}) => Promise<Map<string, string>>;

function splitUnitsNearHalf(units: PaperTranslationUnit[]): [PaperTranslationUnit[], PaperTranslationUnit[]] {
  const target = units.reduce((total, unit) => total + unit.text.length, 0) / 2;
  let characters = 0;
  let splitAt = 1;
  for (let index = 0; index < units.length - 1; index += 1) {
    characters += units[index]!.text.length;
    splitAt = index + 1;
    if (characters >= target) break;
  }
  return [units.slice(0, splitAt), units.slice(splitAt)];
}

export async function translatePaperBatchRecovering(
  input: Parameters<PaperBatchTranslator>[0],
  translator: PaperBatchTranslator = translatePaperBatch,
): Promise<Map<string, string>> {
  const translateSubset = async (
    units: PaperTranslationUnit[],
    context: string,
    singleRetry: boolean,
  ): Promise<Map<string, string>> => {
    try {
      return await translator({ ...input, units, context });
    } catch (reason) {
      if (paperErrorCode(reason) !== "invalid-output") throw reason;
      const recoveryContext = [
        context,
        "Output recovery: return every requested id exactly once as valid JSON. Preserve every __WRP_...__ token exactly.",
      ].filter(Boolean).join("\n\n");
      if (units.length === 1) {
        if (singleRetry) throw reason;
        return translateSubset(units, recoveryContext, true);
      }
      const [leftUnits, rightUnits] = splitUnitsNearHalf(units);
      const left = await translateSubset(leftUnits, recoveryContext, false);
      const recoveredContext = [...left.values()].slice(-2).join("\n");
      const right = await translateSubset(
        rightUnits,
        [recoveryContext, recoveredContext && `Previous translated context:\n${recoveredContext}`].filter(Boolean).join("\n\n"),
        false,
      );
      return new Map([...left, ...right]);
    }
  };
  return translateSubset(input.units, input.context, false);
}

function paperErrorCode(reason: unknown): PaperTranslationError["code"] | undefined {
  const code = (reason as { code?: unknown })?.code;
  return typeof code === "string" && PAPER_ERROR_CODES.has(code as PaperTranslationError["code"])
    ? code as PaperTranslationError["code"] : undefined;
}

interface TranslatorResponseMessage {
  channel: "webreader-paper-translator";
  id: string;
  ok: boolean;
  entries?: Array<[string, string]>;
  error?: { code: PaperTranslationError["code"]; message: string; retryAfterMs?: number };
}

let translatorFramePromise: Promise<{ frame: HTMLIFrameElement; port: MessagePort }> | undefined;

function translatorFrame(): Promise<{ frame: HTMLIFrameElement; port: MessagePort }> {
  if (translatorFramePromise) return translatorFramePromise;
  translatorFramePromise = new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.title = "";
    frame.sandbox.add("allow-scripts", "allow-same-origin");
    frame.src = new URL("./translator.html", document.baseURI).href;
    frame.addEventListener("load", () => {
      const fail = (reason: PaperTranslationError) => {
        translatorFramePromise = undefined;
        frame.remove();
        reject(reason);
      };
      const targetWindow = frame.contentWindow;
      if (!targetWindow) {
        fail(providerError("provider", "The translation runtime could not start."));
        return;
      }
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => {
        channel.port1.close();
        channel.port2.close();
        fail(providerError("provider", "The translation runtime did not respond."));
      }, 5_000);
      channel.port1.onmessage = (event: MessageEvent<{ channel?: string; type?: string }>) => {
        if (event.data?.channel !== "webreader-paper-translator" || event.data.type !== "ready") return;
        window.clearTimeout(timer);
        channel.port1.onmessage = null;
        resolve({ frame, port: channel.port1 });
      };
      channel.port1.start();
      targetWindow.postMessage({ channel: "webreader-paper-translator", type: "connect" }, "*", [channel.port2]);
    }, { once: true });
    frame.addEventListener("error", () => {
      translatorFramePromise = undefined;
      frame.remove();
      reject(providerError("provider", "The translation runtime could not start."));
    }, { once: true });
    document.body.append(frame);
  });
  return translatorFramePromise;
}

export async function translatePaperBatch(input: {
  config: PaperTranslationProviderConfig;
  targetLanguage: TranslationTargetLanguage;
  units: PaperTranslationUnit[];
  context: string;
  signal: AbortSignal;
}): Promise<Map<string, string>> {
  const { port } = await translatorFrame();
  const id = crypto.randomUUID();
  return new Promise<Map<string, string>>((resolve, reject) => {
    const cleanup = () => {
      port.removeEventListener("message", handleMessage);
      input.signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      port.postMessage({ channel: "webreader-paper-translator", type: "cancel", id });
      cleanup();
      reject(providerError("cancelled", "Translation was cancelled."));
    };
    const handleMessage = (event: MessageEvent<TranslatorResponseMessage>) => {
      if (event.data?.channel !== "webreader-paper-translator" || event.data.id !== id) return;
      cleanup();
      if (!event.data.ok || !event.data.entries) {
        const detail = event.data.error;
        const code = detail && PAPER_ERROR_CODES.has(detail.code) ? detail.code : "provider";
        reject(providerError(code, detail?.message ?? "Translation failed.", detail?.retryAfterMs));
        return;
      }
      resolve(new Map(event.data.entries));
    };
    port.addEventListener("message", handleMessage);
    input.signal.addEventListener("abort", handleAbort, { once: true });
    if (input.signal.aborted) {
      handleAbort();
      return;
    }
    port.postMessage({
      channel: "webreader-paper-translator",
      type: "translate",
      id,
      input: {
        config: input.config,
        targetLanguage: input.targetLanguage,
        units: input.units,
        context: input.context,
      },
    });
  });
}
