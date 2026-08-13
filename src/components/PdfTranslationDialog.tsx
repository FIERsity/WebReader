import { KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { providerDefaultEndpoint, validatePaperProviderConfig } from "../lib/paperTranslation";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import type { PaperTranslationProviderConfig, PaperTranslationProviderId, TranslationTargetLanguage } from "../types/translation";

const PROVIDER_MODELS: Record<PaperTranslationProviderId, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-chat",
  "custom-openai": "",
};

interface PdfTranslationDialogProps {
  blockCount: number;
  characterCount: number;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
  onClose: () => void;
  onConfirm: (config: PaperTranslationProviderConfig, targetLanguage: TranslationTargetLanguage) => void;
}

export function PdfTranslationDialog({ blockCount, characterCount, t, onClose, onConfirm }: PdfTranslationDialogProps) {
  const [provider, setProvider] = useState<PaperTranslationProviderId>("deepseek");
  const [model, setModel] = useState(PROVIDER_MODELS.deepseek);
  const [endpoint, setEndpoint] = useState("");
  const [targetLanguage, setTargetLanguage] = useState<TranslationTargetLanguage>("zh-CN");
  const [error, setError] = useState("");
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const changeProvider = (next: PaperTranslationProviderId) => {
    setProvider(next);
    setModel(PROVIDER_MODELS[next]);
    setEndpoint(next === "custom-openai" ? "" : providerDefaultEndpoint(next));
    setError("");
  };

  const submit = () => {
    const config: PaperTranslationProviderConfig = {
      provider,
      model: model.trim(),
      endpoint: provider === "custom-openai" ? endpoint.trim() : undefined,
      apiKey: keyRef.current?.value ?? "",
    };
    try {
      const url = validatePaperProviderConfig(config);
      if (!window.confirm(t("paperTranslationConfirm", {
        host: url.hostname, count: blockCount, characters: characterCount.toLocaleString(),
      }))) return;
      if (keyRef.current) keyRef.current.value = "";
      onConfirm(config, targetLanguage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("paperTranslationConfigInvalid"));
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="dialog translation-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-translation-title">
        <div className="dialog-heading">
          <div className="dialog-icon translation-dialog-icon"><KeyRound /></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("cancel")}><X /></button>
        </div>
        <h2 id="paper-translation-title">{t("paperTranslationSetup")}</h2>
        <p>{t("paperTranslationDisclosure")}</p>
        <label>
          <span>{t("translationProvider")}</span>
          <select value={provider} onChange={(event) => changeProvider(event.target.value as PaperTranslationProviderId)}>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="custom-openai">{t("customOpenAiProvider")}</option>
          </select>
        </label>
        {provider === "custom-openai" && (
          <label>
            <span>{t("apiEndpoint")}</span>
            <input type="url" inputMode="url" value={endpoint} placeholder="https://example.com/v1/chat/completions" onChange={(event) => setEndpoint(event.target.value)} />
          </label>
        )}
        <label>
          <span>{t("model")}</span>
          <input type="text" value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          <span>{t("apiKey")}</span>
          <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} />
        </label>
        <fieldset>
          <legend>{t("translationTarget")}</legend>
          <div className="segmented-control">
            <button type="button" className={targetLanguage === "zh-CN" ? "active" : ""} onClick={() => setTargetLanguage("zh-CN")}>{t("translateToChinese")}</button>
            <button type="button" className={targetLanguage === "en" ? "active" : ""} onClick={() => setTargetLanguage("en")}>{t("translateToEnglish")}</button>
          </div>
        </fieldset>
        <p className="translation-account-note">{t("apiSubscriptionNote")}</p>
        {error && <p className="translation-dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>{t("cancel")}</button>
          <button className="primary-button" type="button" onClick={submit}>{t("translatePaper")}</button>
        </div>
      </section>
    </div>
  );
}
