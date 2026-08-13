import { translatePaperBatchDirect, type PaperTranslationError } from "./lib/paperTranslation";
import type { PaperTranslationProviderConfig, PaperTranslationUnit, TranslationTargetLanguage } from "./types/translation";

const controllers = new Map<string, AbortController>();

interface TranslatorMessage {
  channel: "webreader-paper-translator";
  type: "translate" | "cancel";
  id: string;
  input?: {
    config: PaperTranslationProviderConfig;
    targetLanguage: TranslationTargetLanguage;
    units: PaperTranslationUnit[];
    context: string;
  };
}

function connect(event: MessageEvent<{ channel?: string; type?: string }>) {
  if (event.source !== window.parent || event.data?.channel !== "webreader-paper-translator"
    || event.data.type !== "connect" || event.ports.length !== 1) return;
  window.removeEventListener("message", connect);
  const port = event.ports[0]!;
  port.onmessage = (portEvent: MessageEvent<TranslatorMessage>) => {
    const message = portEvent.data;
    if (message?.channel !== "webreader-paper-translator") return;
    if (message.type === "cancel") {
      controllers.get(message.id)?.abort();
      controllers.delete(message.id);
      return;
    }
    const { id, input } = message;
    if (!input || controllers.has(id)) return;
    const controller = new AbortController();
    controllers.set(id, controller);
    void translatePaperBatchDirect({ ...input, signal: controller.signal }).then((result) => {
      port.postMessage({ channel: "webreader-paper-translator", id, ok: true, entries: [...result.entries()] });
    }).catch((reason: PaperTranslationError) => {
      port.postMessage({
        channel: "webreader-paper-translator", id, ok: false,
        error: { code: reason.code ?? "provider", message: reason.message, retryAfterMs: reason.retryAfterMs },
      });
    }).finally(() => controllers.delete(id));
  };
  port.start();
  port.postMessage({ channel: "webreader-paper-translator", type: "ready" });
}

window.addEventListener("message", connect);
