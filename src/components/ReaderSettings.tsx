import { useEffect, useRef } from "react";
import { Minus, Plus, Settings2, X } from "lucide-react";
import type { Language, TranslationKey, TranslationVariables } from "../lib/i18n";
import type { ReaderPreferences } from "../types/library";

interface ReaderSettingsProps {
  language: Language;
  preferences: ReaderPreferences;
  onLanguageChange: (language: Language) => void;
  onChange: (next: ReaderPreferences) => void;
  onClose: () => void;
  typography: boolean;
  publisherFont: boolean;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
}

const fontOptions: Array<{ value: ReaderPreferences["fontFamily"]; label: TranslationKey }> = [
  { value: "publisher", label: "publisherFont" },
  { value: "serif", label: "serifFont" },
  { value: "sans", label: "sansFont" },
];
const lineOptions: Array<{ value: ReaderPreferences["lineHeight"]; label: TranslationKey }> = [
  { value: 1.4, label: "compact" },
  { value: 1.65, label: "standard" },
  { value: 1.9, label: "relaxed" },
];
const themes: Array<{ value: ReaderPreferences["theme"]; label: TranslationKey }> = [
  { value: "white", label: "whiteTheme" },
  { value: "paper", label: "paperTheme" },
  { value: "night", label: "nightTheme" },
  { value: "contrast", label: "contrastTheme" },
];
const widths: Array<{ value: ReaderPreferences["contentWidth"]; label: TranslationKey }> = [
  { value: "narrow", label: "narrow" },
  { value: "standard", label: "standard" },
  { value: "wide", label: "wide" },
];

export function ReaderSettings({ language, preferences, onLanguageChange, onChange, onClose, typography, publisherFont, triggerRef, t }: ReaderSettingsProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = triggerRef?.current;
    closeRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [triggerRef]);
  const visibleFontOptions = publisherFont ? fontOptions : fontOptions.filter((option) => option.value !== "publisher");
  const selectedFont = publisherFont || preferences.fontFamily !== "publisher" ? preferences.fontFamily : "serif";
  const update = <Key extends keyof ReaderPreferences>(key: Key, value: ReaderPreferences[Key]) => {
    onChange({ ...preferences, [key]: value });
  };
  const resize = (delta: number) => update("fontSizePercent", Math.min(200, Math.max(80, preferences.fontSizePercent + delta)));

  return (
    <aside className="reader-panel settings-panel" aria-label={t("readerSettings")}>
      <header className="reader-panel-header">
        <div><Settings2 /><strong>{t("readerSettings")}</strong></div>
        <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label={t("closeSettings")}><X /></button>
      </header>

      <section className="setting-group">
        <span className="setting-label">{t("language")}</span>
        <div className="segmented-control" role="group" aria-label={t("language")}>
          <button type="button" className={language === "zh" ? "active" : ""} aria-pressed={language === "zh"} onClick={() => onLanguageChange("zh")}>中</button>
          <button type="button" className={language === "en" ? "active" : ""} aria-pressed={language === "en"} onClick={() => onLanguageChange("en")}>EN</button>
        </div>
      </section>

      {typography && (
        <>
          <section className="setting-group">
            <span className="setting-label">{t("textSize")}</span>
            <div className="font-size-control">
              <button className="icon-button" type="button" onClick={() => resize(-10)} disabled={preferences.fontSizePercent <= 80} aria-label={t("decreaseTextSize")}><Minus /></button>
              <output>{preferences.fontSizePercent}%</output>
              <button className="icon-button" type="button" onClick={() => resize(10)} disabled={preferences.fontSizePercent >= 200} aria-label={t("increaseTextSize")}><Plus /></button>
            </div>
            <input aria-label={t("textSize")} type="range" min="80" max="200" step="10" value={preferences.fontSizePercent} onChange={(event) => update("fontSizePercent", Number(event.target.value))} />
          </section>

          <label className="setting-group">
            <span className="setting-label">{t("fontFamily")}</span>
            <select value={selectedFont} onChange={(event) => update("fontFamily", event.target.value as ReaderPreferences["fontFamily"])}>
              {visibleFontOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>

          <section className="setting-group">
            <span className="setting-label">{t("lineHeight")}</span>
            <div className="segmented-control">
              {lineOptions.map((option) => (
                <button key={option.value} type="button" className={preferences.lineHeight === option.value ? "active" : ""} aria-pressed={preferences.lineHeight === option.value} onClick={() => update("lineHeight", option.value)}>{t(option.label)}</button>
              ))}
            </div>
          </section>

          <section className="setting-group">
            <span className="setting-label">{t("paragraphIndent")}</span>
            <div className="segmented-control">
              <button type="button" className={preferences.paragraphIndent === 0 ? "active" : ""} aria-pressed={preferences.paragraphIndent === 0} onClick={() => update("paragraphIndent", 0)}>{t("noIndent")}</button>
              <button type="button" className={preferences.paragraphIndent === 2 ? "active" : ""} aria-pressed={preferences.paragraphIndent === 2} onClick={() => update("paragraphIndent", 2)}>{t("twoCharacterIndent")}</button>
            </div>
          </section>
        </>
      )}

      <section className="setting-group">
        <span className="setting-label">{t("background")}</span>
        <div className="theme-options">
          {themes.map((theme) => (
            <button key={theme.value} type="button" className={`theme-option theme-swatch-${theme.value} ${preferences.theme === theme.value ? "active" : ""}`} aria-pressed={preferences.theme === theme.value} onClick={() => update("theme", theme.value)}>
              <i aria-hidden="true" /><span>{t(theme.label)}</span>
            </button>
          ))}
        </div>
      </section>

      {typography && (
        <section className="setting-group">
          <span className="setting-label">{t("contentWidth")}</span>
          <div className="segmented-control">
            {widths.map((option) => (
              <button key={option.value} type="button" className={preferences.contentWidth === option.value ? "active" : ""} aria-pressed={preferences.contentWidth === option.value} onClick={() => update("contentWidth", option.value)}>{t(option.label)}</button>
            ))}
          </div>
        </section>
      )}

      <p className="panel-note shortcuts-note">{t("keyboardShortcuts")}</p>
    </aside>
  );
}
