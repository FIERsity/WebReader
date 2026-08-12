import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen, ChevronLeft, ChevronRight, FileText, Import, Library,
  ListTree, MessageSquare, Plus, Settings2, Trash2, X,
} from "lucide-react";
import "./App.css";
import { ReaderOutline } from "./components/ReaderOutline";
import { ReaderSettings } from "./components/ReaderSettings";
import { submitFeedback, MAX_FEEDBACK_LENGTH } from "./lib/feedback";
import { BookFormatError, detectBookFormat, displayTitle, formatBytes } from "./lib/formats";
import { fingerprintFile } from "./lib/fingerprint";
import { resolveLanguage, translate, type Language, type TranslationKey, type TranslationVariables } from "./lib/i18n";
import { handleReaderShortcut } from "./lib/readerShortcuts";
import {
  findByFingerprint, getBookFile, getPreferences, listBooks, removeBook,
  requestPersistentStorage, saveBook, savePreferences, updateLocator,
} from "./lib/storage";
import type { BookRecord, ReaderPreferences, ReadingLocator } from "./types/library";
import { DEFAULT_PREFERENCES } from "./types/library";
import type { ReaderCapabilities, ReaderController, ReaderOutlineItem } from "./types/reader";
import { NO_READER_CAPABILITIES } from "./types/reader";

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
  const [readerPanel, setReaderPanel] = useState<"outline" | "settings">();
  const [outline, setOutline] = useState<ReaderOutlineItem[]>([]);
  const [automaticOutline, setAutomaticOutline] = useState(false);
  const [currentTarget, setCurrentTarget] = useState<string>();
  const [readerLabel, setReaderLabel] = useState<string>();
  const [capabilities, setCapabilities] = useState<ReaderCapabilities>(NO_READER_CAPABILITIES);
  const [updateAction, setUpdateAction] = useState<(() => void) | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const outlineButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<ReaderController | null>(null);
  const shortcutActionsRef = useRef<{
    previous: () => void;
    next: () => void;
    decreaseText: () => void;
    increaseText: () => void;
    toggleOutline: () => void;
    closePanel: () => void;
    typography: boolean;
  }>({
    previous: () => undefined,
    next: () => undefined,
    decreaseText: () => undefined,
    increaseText: () => undefined,
    toggleOutline: () => undefined,
    closePanel: () => undefined,
    typography: false,
  });

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
    setReaderPanel(undefined);
    setOutline([]);
    setAutomaticOutline(false);
    setCurrentTarget(undefined);
    setReaderLabel(book.locator?.label);
    setCapabilities(NO_READER_CAPABILITIES);
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
    setReaderPanel(undefined);
    setOutline([]);
    setReaderLabel(undefined);
    setCapabilities(NO_READER_CAPABILITIES);
    await refreshBooks();
  }, [refreshBooks]);

  const activeBookId = activeBook?.id;
  const handleProgress = useCallback((locator: ReadingLocator) => {
    if (!activeBookId) return;
    setReaderLabel(locator.label);
    void updateLocator(activeBookId, locator);
    setActiveBook((current) => current?.id === activeBookId ? { ...current, locator } : current);
  }, [activeBookId]);

  const updatePreferences = useCallback((next: ReaderPreferences) => {
    setPreferences(next);
    void savePreferences(next);
  }, []);

  const adjustTextSize = useCallback((delta: number) => {
    setPreferences((current) => {
      const next = {
        ...current,
        fontSizePercent: Math.min(200, Math.max(80, current.fontSizePercent + delta)),
      };
      void savePreferences(next);
      return next;
    });
  }, []);

  const handleOutline = useCallback((items: ReaderOutlineItem[], automatic = false) => {
    setOutline(items);
    setAutomaticOutline(automatic);
  }, []);
  const handleCapabilities = useCallback((next: ReaderCapabilities) => setCapabilities(next), []);
  const handleCurrentTarget = useCallback((target?: string) => setCurrentTarget(target), []);
  const handleLocationLabel = useCallback((label?: string) => setReaderLabel(label), []);
  const handleReaderKeyDown = useCallback((event: KeyboardEvent) => {
    handleReaderShortcut(event, shortcutActionsRef.current);
  }, []);

  shortcutActionsRef.current = {
    previous: () => navigationRef.current?.previous(),
    next: () => navigationRef.current?.next(),
    decreaseText: () => adjustTextSize(-10),
    increaseText: () => adjustTextSize(10),
    toggleOutline: () => {
      if (capabilities.outline) setReaderPanel((current) => current === "outline" ? undefined : "outline");
    },
    closePanel: () => setReaderPanel(undefined),
    typography: capabilities.typography,
  };

  useEffect(() => {
    if (!activeBook) return;
    document.addEventListener("keydown", handleReaderKeyDown);
    return () => document.removeEventListener("keydown", handleReaderKeyDown);
  }, [activeBook, handleReaderKeyDown]);

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
      <main className={`reader-shell theme-${preferences.theme} ${readerPanel ? "panel-open" : ""}`}>
        <header className="reader-toolbar">
          <div className="reader-leading-controls">
            <button className="icon-button" type="button" onClick={() => void closeReader()} title={t("backToLibrary")} aria-label={t("backToLibrary")}>
              <ChevronLeft />
            </button>
            <button
              ref={outlineButtonRef}
              className={`icon-button ${readerPanel === "outline" ? "active" : ""}`}
              type="button"
              title={t("tableOfContents")}
              aria-label={t("tableOfContents")}
              aria-expanded={readerPanel === "outline"}
              disabled={!capabilities.outline}
              onClick={() => setReaderPanel((current) => current === "outline" ? undefined : "outline")}
            >
              <ListTree />
            </button>
          </div>
          <div className="reader-title">
            <strong>{activeBook.title}</strong>
            <span>{readerLabel ?? formatLabel(activeBook.format)}</span>
          </div>
          <div className="reader-controls">
            <button
              ref={settingsButtonRef}
              className={`icon-button ${readerPanel === "settings" ? "active" : ""}`}
              type="button"
              title={t("readerSettings")}
              aria-label={t("readerSettings")}
              aria-expanded={readerPanel === "settings"}
              onClick={() => setReaderPanel((current) => current === "settings" ? undefined : "settings")}
            >
              <Settings2 />
            </button>
            {languageControl}
          </div>
        </header>
        <div className="reader-workspace">
          {readerPanel === "outline" && (
            <ReaderOutline
              items={outline}
              currentTarget={currentTarget}
              automatic={automaticOutline}
              onNavigate={(target) => {
                navigationRef.current?.goTo?.(target);
                setReaderPanel(undefined);
              }}
              onClose={() => setReaderPanel(undefined)}
              triggerRef={outlineButtonRef}
              t={t}
            />
          )}
          <section className="reading-surface" aria-hidden={readerPanel ? true : undefined} inert={readerPanel ? true : undefined}>
            <Suspense fallback={<div className="reader-loading">{t("preparingBook")}</div>}>
              {activeBook.format === "epub" && (
                <EpubReader
                  file={activeFile}
                  locator={activeBook.locator}
                  preferences={preferences}
                  onProgress={handleProgress}
                  onOutline={handleOutline}
                  onCapabilities={handleCapabilities}
                  onCurrentTarget={handleCurrentTarget}
                  onLocationLabel={handleLocationLabel}
                  onKeyDown={handleReaderKeyDown}
                  navigationRef={navigationRef}
                  t={t}
                />
              )}
              {activeBook.format === "pdf" && (
                <PdfReader
                  file={activeFile}
                  locator={activeBook.locator}
                  preferences={preferences}
                  onProgress={handleProgress}
                  onOutline={handleOutline}
                  onCapabilities={handleCapabilities}
                  onCurrentTarget={handleCurrentTarget}
                  navigationRef={navigationRef}
                  t={t}
                />
              )}
              {activeBook.format === "txt" && (
                <TextReader
                  file={activeFile}
                  fileName={activeBook.fileName}
                  mediaType={activeBook.mediaType}
                  locator={activeBook.locator}
                  preferences={preferences}
                  onProgress={handleProgress}
                  onOutline={handleOutline}
                  onCapabilities={handleCapabilities}
                  onCurrentTarget={handleCurrentTarget}
                  navigationRef={navigationRef}
                  t={t}
                />
              )}
            </Suspense>
            <button className="page-turn page-turn-left" type="button" onClick={() => navigationRef.current?.previous()} aria-label={t("previousPage")}><ChevronLeft /></button>
            <button className="page-turn page-turn-right" type="button" onClick={() => navigationRef.current?.next()} aria-label={t("nextPage")}><ChevronRight /></button>
          </section>
          {readerPanel === "settings" && (
            <ReaderSettings
              preferences={preferences}
              typography={capabilities.typography}
              publisherFont={capabilities.publisherFont}
              triggerRef={settingsButtonRef}
              onChange={updatePreferences}
              onClose={() => setReaderPanel(undefined)}
              t={t}
            />
          )}
        </div>
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
