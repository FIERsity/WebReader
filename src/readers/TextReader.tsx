import { useEffect, useRef, useState } from "react";
import type { ReaderPreferences, ReadingLocator } from "../types/library";

interface TextReaderProps {
  file: Blob;
  locator?: ReadingLocator;
  preferences: ReaderPreferences;
  onProgress: (locator: ReadingLocator) => void;
  navigationRef: React.RefObject<{ previous: () => void; next: () => void } | null>;
}

async function decodeText(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return new TextDecoder().decode(buffer);
    }
  }
}

export function TextReader({ file, locator, preferences, onProgress, navigationRef }: TextReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void decodeText(file).then((value) => {
      if (active) setText(value.replace(/^\uFEFF/, ""));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "This text file could not be decoded.");
    });
    return () => { active = false; };
  }, [file]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !text) return;
    const saved = locator?.type === "text" ? locator.progression : 0;
    requestAnimationFrame(() => {
      element.scrollTop = saved * Math.max(0, element.scrollHeight - element.clientHeight);
    });
  }, [locator?.progression, locator?.type, text]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let timer = 0;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const maximum = Math.max(1, element.scrollHeight - element.clientHeight);
        const progression = Math.max(0, Math.min(1, element.scrollTop / maximum));
        onProgress({
          type: "text",
          value: String(Math.round(progression * text.length)),
          progression,
          label: `${Math.round(progression * 100)}%`,
        });
      }, 250);
    };
    element.addEventListener("scroll", save, { passive: true });
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("scroll", save);
    };
  }, [onProgress, text.length]);

  useEffect(() => {
    navigationRef.current = {
      previous: () => scrollRef.current?.scrollBy({ top: -(scrollRef.current.clientHeight * 0.86), behavior: "smooth" }),
      next: () => scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.86, behavior: "smooth" }),
    };
    return () => { navigationRef.current = null; };
  }, [navigationRef]);

  if (error) return <p className="reader-error">{error}</p>;

  return (
    <div className={`reader-stage text-stage theme-${preferences.theme}`} ref={scrollRef}>
      <article style={{ fontSize: `${preferences.fontScale}rem`, lineHeight: preferences.lineHeight }}>
        {text || "Loading text..."}
      </article>
    </div>
  );
}
