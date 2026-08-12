import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen, ChevronLeft, ChevronRight, FileText, Import, Library,
  MessageSquare, Moon, Plus, Sun, Trash2, Type, X,
} from "lucide-react";
import "./App.css";
import { submitFeedback, MAX_FEEDBACK_LENGTH } from "./lib/feedback";
import { BookFormatError, detectBookFormat, displayTitle, formatBytes } from "./lib/formats";
import { fingerprintFile } from "./lib/fingerprint";
import { resolveLanguage, translate, type Language, type TranslationKey, type TranslationVariables } from "./lib/i18n";
import {
  findByFingerprint, getBookFile, getPreferences, listBooks, removeBook,
  requestPersistentStorage, saveBook, savePreferences, updateLocator,
} from "./lib/storage";
import type { BookRecord, ReaderPreferences, ReadingLocator } from "./types/library";
import { DEFAULT_PREFERENCES } from "./types/library";

const EpubReader = lazy(() => import("./readers/EpubReader").then((module) => ({ default: module.EpubReader })));
const PdfReader = lazy(() => import("./readers/PdfReader").then((module) => ({ default: module.PdfReader })));
const TextReader = lazy(() => import("./readers/TextReader").then((module) => ({ default: module.TextReader })));

const LANGUAGE_KEY = "webreader.language";

function formatDate(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", year: "numeric" })
    .format(timestamp);
}

function formatLabel(format: BookRecord["format"]): string {
  return format === "txt" ? "TEXT" : format.toUpperCase();
}

function FeedbackDialog({ language, onClose, onSuccess }: {
  language: Language;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useCallback((key: TranslationKey, variables: TranslationVariables = {}) => translate(language, key, variables), [language]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, sending]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await submitFeedback(text, language);
      onSuccess();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !sending) onClose(); }}>
      <section className="dialog feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <div className="dialog-heading">
          <div className="dialog-icon feedback-icon"><MessageSquare /></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={sending} aria-label={t("cancel")}><X /></button>
        </div>
        <h2 id="feedback-title">{t("feedbackTitle")}</h2>
        <p>{t("feedbackHint")}</p>
        <textarea
          autoFocus
          rows={5}
          maxLength={MAX_FEEDBACK_LENGTH}
          value={text}
          placeholder={t("feedbackPlaceholder")}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="feedback-meta">
          <span className={failed ? "feedback-error" : ""}>{failed ? t("feedbackFailure") : ""}</span>
          <span>{t("feedbackCounter", { count: text.length, max: MAX_FEEDBACK_LENGTH })}</span>
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={sending}>{t("cancel")}</button>
          <button className="primary-button" type="button" onClick={() => void send()} disabled={sending || !text.trim()}>{sending ? t("sending") : t("send")}</button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => resolveLanguage(localStorage.getItem(LANGUAGE_KEY)));
  const t = useCallback((key: TranslationKey, variables: TranslationVariables = {}) => translate(language, key, variables), [language]);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [activeBook, setActiveBook] = useState<BookRecord>();
  const [activeFile, setActiveFile] = useState<Blob>();
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<BookRecord>();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [updateAction, setUpdateAction] = useState<(() => void) | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<{ previous: () => void; next: () => void } | null>(null);

  const refreshBooks = useCallback(async () => setBooks(await listBooks()), []);

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = t("pageTitle");
  }, [language, t]);

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const activate = (event as CustomEvent<() => Promise<void>>).detail;
      setUpdateAction(() => () => void activate());
    };
    window.addEventListener("webreader-update-available", handleUpdate);
    return () => window.removeEventListener("webreader-update-available", handleUpdate);
  }, []);

  useEffect(() => {
    void Promise.all([listBooks(), getPreferences()]).then(([storedBooks, storedPreferences]) => {
      setBooks(storedBooks);
      setPreferences(storedPreferences);
    }).catch(() => setMessage(t("storageUnavailable")));
    void requestPersistentStorage();
  }, [t]);

  const importFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    let imported = 0;
    try {
      for (const file of files) {
        const format = await detectBookFormat(file);
        const fingerprint = await fingerprintFile(file);
        const existing = await findByFingerprint(fingerprint);
        if (existing) {
          setMessage(t("duplicateBook", { title: existing.title }));
          continue;
        }
        const now = Date.now();
        const book: BookRecord = {
          id: crypto.randomUUID(),
          fingerprint,
          title: displayTitle(file.name),
          format,
          fileName: file.name,
          mediaType: file.type || (format === "txt" ? "text/plain" : `application/${format}`),
          size: file.size,
          addedAt: now,
          updatedAt: now,
        };
        await saveBook(book, file);
        imported += 1;
      }
      await refreshBooks();
      if (imported > 0) setMessage(imported === 1 ? t("importedOne") : t("importedMany", { count: imported }));
    } catch (error) {
      setMessage(error instanceof BookFormatError ? t(error.translationKey) : t("importFailed"));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [refreshBooks, t]);

  const openBook = useCallback(async (book: BookRecord) => {
    setMessage(undefined);
    try {
      const file = await getBookFile(book.id);
      setActiveFile(file);
      setActiveBook(book);
    } catch {
      setMessage(t("openFailed"));
    }
  }, [t]);

  const closeReader = useCallback(async () => {
    setActiveBook(undefined);
    setActiveFile(undefined);
    await refreshBooks();
  }, [refreshBooks]);

  const handleProgress = useCallback((locator: ReadingLocator) => {
    if (!activeBook) return;
    void updateLocator(activeBook.id, locator);
  }, [activeBook]);

  const updatePreferences = useCallback((next: ReaderPreferences) => {
    setPreferences(next);
    void savePreferences(next);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    await removeBook(deleteTarget.id);
    setDeleteTarget(undefined);
    await refreshBooks();
  }, [deleteTarget, refreshBooks]);

  const languageControl = (
    <div className="language-switch" role="group" aria-label={t("language")}>
      <button type="button" className={language === "zh" ? "active" : ""} aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>中</button>
      <button type="button" className={language === "en" ? "active" : ""} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>EN</button>
    </div>
  );

  if (activeBook && activeFile) {
    return (
      <main className={`reader-shell theme-${preferences.theme}`}>
        <header className="reader-toolbar">
          <button className="icon-button" type="button" onClick={() => void closeReader()} title={t("backToLibrary")} aria-label={t("backToLibrary")}>
            <ChevronLeft />
          </button>
          <div className="reader-title">
            <strong>{activeBook.title}</strong>
            <span>{activeBook.locator?.label ?? formatLabel(activeBook.format)}</span>
          </div>
          <div className="reader-controls">
            {activeBook.format !== "pdf" && (
              <label className="compact-control" title={t("textSize")}>
                <Type aria-hidden="true" />
                <input
                  aria-label={t("textSize")}
                  type="range"
                  min="0.8"
                  max="1.5"
                  step="0.1"
                  value={preferences.fontScale}
                  onChange={(event) => updatePreferences({ ...preferences, fontScale: Number(event.target.value) })}
                />
              </label>
            )}
            <button
              className="icon-button"
              type="button"
              title={preferences.theme === "night" ? t("usePaperTheme") : t("useNightTheme")}
              aria-label={preferences.theme === "night" ? t("usePaperTheme") : t("useNightTheme")}
              onClick={() => updatePreferences({ ...preferences, theme: preferences.theme === "night" ? "paper" : "night" })}
            >
              {preferences.theme === "night" ? <Sun /> : <Moon />}
            </button>
            {languageControl}
          </div>
        </header>
        <section className="reading-surface">
          <Suspense fallback={<div className="reader-loading">{t("preparingBook")}</div>}>
            {activeBook.format === "epub" && (
              <EpubReader file={activeFile} locator={activeBook.locator} preferences={preferences} onProgress={handleProgress} navigationRef={navigationRef} t={t} />
            )}
            {activeBook.format === "pdf" && (
              <PdfReader file={activeFile} locator={activeBook.locator} preferences={preferences} onProgress={handleProgress} navigationRef={navigationRef} t={t} />
            )}
            {activeBook.format === "txt" && (
              <TextReader file={activeFile} locator={activeBook.locator} preferences={preferences} onProgress={handleProgress} navigationRef={navigationRef} t={t} />
            )}
          </Suspense>
          <button className="page-turn page-turn-left" type="button" onClick={() => navigationRef.current?.previous()} aria-label={t("previousPage")}><ChevronLeft /></button>
          <button className="page-turn page-turn-right" type="button" onClick={() => navigationRef.current?.next()} aria-label={t("nextPage")}><ChevronRight /></button>
        </section>
      </main>
    );
  }

  return (
    <main className="library-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><BookOpen /></span><span>WebReader</span></div>
        <nav aria-label={t("librarySections")}>
          <button className="nav-item active" type="button"><Library />{t("library")} <span>{books.length}</span></button>
        </nav>
        <div className="sidebar-actions">
          {languageControl}
          <button className="feedback-button" type="button" onClick={() => setFeedbackOpen(true)}><MessageSquare />{t("feedback")}</button>
        </div>
        <div className="privacy-note">
          <strong>{t("privateTitle")}</strong>
          <span>{t("privateNote")}</span>
        </div>
      </aside>

      <section className="library-main">
        <header className="library-header">
          <div><p className="eyebrow">{t("localLibrary")}</p><h1>{t("yourBooks")}</h1></div>
          <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Plus />{busy ? t("importing") : t("addBooks")}
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".epub,.pdf,.txt,.md,application/epub+zip,application/pdf,text/plain,text/markdown"
            multiple
            onChange={(event) => void importFiles(Array.from(event.target.files ?? []))}
          />
        </header>

        {message && <div className="notice" role="status"><span>{message}</span><button type="button" onClick={() => setMessage(undefined)} aria-label={t("dismiss")}><X /></button></div>}
        {updateAction && (
          <div className="notice update-notice" role="status">
            <span>{t("updateReady")}</span>
            <button className="notice-action" type="button" onClick={updateAction}>{t("update")}</button>
          </div>
        )}

        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Import />
          <span>{t("dropBooks")}</span>
          <small>{t("maxFileSize")}</small>
        </div>

        {books.length === 0 ? (
          <section className="empty-state">
            <div className="empty-icon"><BookOpen /></div>
            <h2>{t("shelfEmpty")}</h2>
            <p>{t("shelfEmptyText")}</p>
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}><Plus />{t("chooseFiles")}</button>
          </section>
        ) : (
          <section className="book-grid" aria-label={t("books")}>
            {books.map((book) => {
              const percent = Math.round((book.locator?.progression ?? 0) * 100);
              return (
                <article className="book-card" key={book.id}>
                  <button className="book-open" type="button" onClick={() => void openBook(book)} aria-label={t("openBook", { title: book.title })}>
                    <div className={`book-cover cover-${book.format}`}>
                      {book.format === "pdf" ? <FileText /> : <BookOpen />}
                      <span>{formatLabel(book.format)}</span>
                    </div>
                    <div className="book-info">
                      <strong>{book.title}</strong>
                      <span>{book.author ?? book.fileName}</span>
                      <div className="progress-track"><i style={{ width: `${percent}%` }} /></div>
                      <small>{book.locator ? t("percentRead", { percent }) : t("addedOn", { date: formatDate(book.addedAt, language) })} · {formatBytes(book.size)}</small>
                    </div>
                  </button>
                  <button className="card-menu" type="button" title={t("removeBook", { title: book.title })} aria-label={t("removeBook", { title: book.title })} onClick={() => setDeleteTarget(book)}><Trash2 /></button>
                </article>
              );
            })}
          </section>
        )}
      </section>

      {deleteTarget && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDeleteTarget(undefined); }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <div className="dialog-icon"><Trash2 /></div>
            <h2 id="delete-title">{t("removeTitle")}</h2>
            <p>{t("removeDescription", { title: deleteTarget.title })}</p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setDeleteTarget(undefined)}>{t("cancel")}</button>
              <button className="danger-button" type="button" onClick={() => void confirmDelete()}>{t("remove")}</button>
            </div>
          </section>
        </div>
      )}

      {feedbackOpen && <FeedbackDialog language={language} onClose={() => setFeedbackOpen(false)} onSuccess={() => { setFeedbackOpen(false); setMessage(t("feedbackSuccess")); }} />}
    </main>
  );
}
