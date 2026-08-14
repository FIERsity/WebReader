import { LoaderCircle, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_SEARCH_QUERY_LENGTH, MAX_SEARCH_RESULTS } from "../lib/readerSearch";
import type { TranslationKey, TranslationVariables } from "../lib/i18n";
import type { ReaderController, ReaderSearchResult } from "../types/reader";

interface ReaderSearchProps {
  controllerRef: React.RefObject<ReaderController | null>;
  onClose: () => void;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function ReaderSearch({ controllerRef, onClose, t, triggerRef }: ReaderSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReaderSearchResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const trigger = triggerRef?.current;
    const controller = controllerRef.current;
    inputRef.current?.focus();
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      controller?.clearSearch?.();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [controllerRef, triggerRef]);

  const runSearch = useCallback(async () => {
    const value = query.trim();
    const controller = controllerRef.current;
    if (!value || !controller?.search) return;
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSearching(true);
    setFailed(false);
    setSearched(true);
    setResults([]);
    setTruncated(false);
    setProgress(0);
    try {
      const outcome = await controller.search(value, {
        signal: abortController.signal,
        maxResults: MAX_SEARCH_RESULTS,
        onProgress: (next) => {
          if (generationRef.current === generation) setProgress(Math.max(0, Math.min(1, next)));
        },
      });
      if (generationRef.current !== generation || abortController.signal.aborted) return;
      setResults(outcome.results);
      setTruncated(outcome.truncated);
      setProgress(1);
    } catch (error) {
      if ((error as { name?: string })?.name !== "AbortError" && generationRef.current === generation) setFailed(true);
    } finally {
      if (generationRef.current === generation) setSearching(false);
    }
  }, [controllerRef, query]);

  return (
    <aside className="reader-panel search-panel" aria-label={t("searchBook")}>
      <header className="reader-panel-header">
        <div><Search /><strong>{t("searchBook")}</strong></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t("closeSearch")}><X /></button>
      </header>
      <form className="reader-search-form" role="search" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
        <label className="sr-only" htmlFor="reader-search-input">{t("searchBook")}</label>
        <input
          id="reader-search-input"
          ref={inputRef}
          type="search"
          maxLength={MAX_SEARCH_QUERY_LENGTH}
          value={query}
          placeholder={t("searchPlaceholder")}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="primary-button" type="submit" disabled={searching || !query.trim()} aria-label={t("searchAction")}>
          {searching ? <LoaderCircle className="spin" /> : <Search />}
        </button>
      </form>
      <div className="search-summary" role="status" aria-live="polite">
        {searching
          ? t("searchProgress", { percent: Math.round(progress * 100) })
          : failed
            ? t("searchFailed")
            : searched
              ? t("searchResultCount", { count: results.length })
              : t("searchLocalHint")}
      </div>
      {truncated && <p className="panel-note">{t("searchTruncated", { count: MAX_SEARCH_RESULTS })}</p>}
      <div className="search-results">
        {!searching && searched && !failed && results.length === 0 && <p className="empty-panel">{t("noSearchResults")}</p>}
        {results.map((result) => (
          <button className="search-result" type="button" key={result.id} onClick={() => controllerRef.current?.goToSearch?.(result)}>
            {result.label && <strong>{result.label}</strong>}
            <span>{result.excerpt.pre}<mark>{result.excerpt.match}</mark>{result.excerpt.post}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
