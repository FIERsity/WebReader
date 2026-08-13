import { type ReactNode, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen, ChevronLeft, ChevronRight, FileText, Import, Library,
  ListTree, MessageSquare, Plus, Rows3, Settings2, Trash2, X,
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
  requestPersistentStorage, saveBook, savePreferences, updateLocator, updateReadingProfile,
} from "./lib/storage";
import type { BookRecord, ReaderPreferences, ReadingLocator, ReadingProfile } from "./types/library";
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

function ModalFrame({ children, className = "", labelledBy, locked = false, onClose }: {
  children: ReactNode;
  className?: string;
  labelledBy: string;
  locked?: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const lockedRef = useRef(locked);
  onCloseRef.current = onClose;
  lockedRef.current = locked;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    const background = [...(backdrop?.parentElement?.children ?? [])]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    for (const { element } of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    (dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0])?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !lockedRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const { element, inert, ariaHidden } of background) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !locked) onClose();
    }}>
      <section ref={dialogRef} tabIndex={-1} className={`dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-busy={locked || undefined}>
        {children}
      </section>
    </div>
  );
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
    <ModalFrame className="feedback-dialog" labelledBy="feedback-title" locked={sending} onClose={onClose}>
        <div className="dialog-heading">
          <div className="dialog-icon feedback-icon"><MessageSquare /></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={sending} aria-label={t("cancel")}><X /></button>
        </div>
        <h2 id="feedback-title">{t("feedbackTitle")}</h2>
        <p>{t("feedbackHint")}</p>
        <textarea
          data-autofocus
          rows={5}
          maxLength={MAX_FEEDBACK_LENGTH}
          value={text}
          placeholder={t("feedbackPlaceholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send(); }}
        />
        <div className="feedback-meta">
          <span className={failed ? "feedback-error" : ""}>{failed ? t("feedbackFailure") : ""}</span>
          <span>{t("feedbackCounter", { count: text.length, max: MAX_FEEDBACK_LENGTH })}</span>
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={sending}>{t("cancel")}</button>
          <button className="primary-button" type="button" onClick={() => void send()} disabled={sending || !text.trim()}>{sending ? t("sending") : t("send")}</button>
        </div>
    </ModalFrame>
  );
}

function DeleteDialog({ book, t, onClose, onConfirm }: {
  book: BookRecord;
  t: (key: TranslationKey, variables?: TranslationVariables) => string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = async () => {
    if (removing) return;
    setRemoving(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      setFailed(true);
      setRemoving(false);
    }
  };

  return (
    <ModalFrame labelledBy="delete-title" locked={removing} onClose={onClose}>
      <div className="dialog-icon"><Trash2 /></div>
      <h2 id="delete-title">{t("removeTitle")}</h2>
      <p>{t("removeDescription", { title: book.title })}</p>
      {failed && <p className="dialog-error" role="alert">{t("removeFailed")}</p>}
      <div className="dialog-actions">
        <button data-autofocus className="secondary-button" type="button" onClick={onClose} disabled={removing}>{t("cancel")}</button>
        <button className="danger-button" type="button" onClick={() => void confirm()} disabled={removing}>{removing ? t("removing") : t("remove")}</button>
      </div>
    </ModalFrame>
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
  const profileWriteRef = useRef(Promise.resolve());
  const readingProfileRef = useRef(new Map<string, ReadingProfile>());
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

  const refreshBooks = useCallback(async () => {
    const storedBooks = await listBooks();
    for (const book of storedBooks) readingProfileRef.current.set(book.id, book.readingProfile);
    setBooks(storedBooks);
  }, []);

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
      for (const book of storedBooks) readingProfileRef.current.set(book.id, book.readingProfile);
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
    let skipped = 0;
    let lastError: string | undefined;
    try {
      for (const file of files) {
        try {
          const format = await detectBookFormat(file);
          const fingerprint = await fingerprintFile(file);
          const existing = await findByFingerprint(fingerprint);
          if (existing) {
            skipped += 1;
            lastError = t("duplicateBook", { title: existing.title });
            continue;
          }
          const now = Date.now();
          const book: BookRecord = {
            id: crypto.randomUUID(),
            fingerprint,
            title: displayTitle(file.name),
            format,
            readingProfile: "book",
            fileName: file.name,
            mediaType: file.type || (format === "txt" ? "text/plain" : `application/${format}`),
            size: file.size,
            addedAt: now,
            updatedAt: now,
          };
          await saveBook(book, file);
          readingProfileRef.current.set(book.id, book.readingProfile);
          imported += 1;
        } catch (error) {
          skipped += 1;
          lastError = error instanceof BookFormatError ? t(error.translationKey) : t("importFailed");
        }
      }
      if (imported > 0) await refreshBooks();
      if (imported > 0 && skipped > 0) setMessage(t("importedWithSkipped", { imported, skipped }));
      else if (imported > 0) setMessage(imported === 1 ? t("importedOne") : t("importedMany", { count: imported }));
      else if (lastError) setMessage(lastError);
    } finally {
      setBusy(false);
      setDragging(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [refreshBooks, t]);

  const openBook = useCallback(async (book: BookRecord) => {
    const currentBook = {
      ...book,
      readingProfile: readingProfileRef.current.get(book.id) ?? book.readingProfile,
    };
    setMessage(undefined);
    setReaderPanel(undefined);
    setOutline([]);
    setAutomaticOutline(false);
    setCurrentTarget(undefined);
    setReaderLabel(currentBook.locator?.label);
    setCapabilities(NO_READER_CAPABILITIES);
    try {
      const file = await getBookFile(currentBook.id);
      setActiveFile(file);
      setActiveBook(currentBook);
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

  const changeReadingProfile = useCallback((book: BookRecord, readingProfile: ReadingProfile) => {
    readingProfileRef.current.set(book.id, readingProfile);
    setBooks((current) => current.map((item) => item.id === book.id ? { ...item, readingProfile } : item));
    setActiveBook((current) => current?.id === book.id ? { ...current, readingProfile } : current);
    profileWriteRef.current = profileWriteRef.current
      .then(() => updateReadingProfile(book.id, readingProfile))
      .catch(() => {
        setMessage(t("storageUnavailable"));
        return refreshBooks();
      });
  }, [refreshBooks, t]);

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
            {capabilities.readingProfile && (
              <div className="reading-mode-switch" role="group" aria-label={t("readingMode")}>
                <button
                  type="button"
                  className={activeBook.readingProfile === "book" ? "active" : ""}
                  aria-pressed={activeBook.readingProfile === "book"}
                  title={t("pagedMode")}
                  onClick={() => changeReadingProfile(activeBook, "book")}
                ><BookOpen /><span>{t("pagedMode")}</span></button>
                <button
                  type="button"
                  className={activeBook.readingProfile === "article" ? "active" : ""}
                  aria-pressed={activeBook.readingProfile === "article"}
                  title={t("scrollMode")}
                  onClick={() => changeReadingProfile(activeBook, "article")}
                ><Rows3 /><span>{t("scrollMode")}</span></button>
              </div>
            )}
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
                  readingProfile={activeBook.readingProfile}
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
                  readingProfile={activeBook.readingProfile}
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
                  readingProfile={activeBook.readingProfile}
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
            {capabilities.paginated && (
              <>
                <button className="page-turn page-turn-left" type="button" onClick={() => navigationRef.current?.previous()} aria-label={t("previousPage")}><ChevronLeft /></button>
                <button className="page-turn page-turn-right" type="button" onClick={() => navigationRef.current?.next()} aria-label={t("nextPage")}><ChevronRight /></button>
              </>
            )}
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
            disabled={busy}
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

        <button
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => fileInputRef.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Import />
          <span>{t("dropBooks")}</span>
          <small>{t("maxFileSize")}</small>
        </button>

        {books.length === 0 ? (
          <section className="empty-state">
            <div className="empty-icon"><BookOpen /></div>
            <h2>{t("shelfEmpty")}</h2>
            <p>{t("shelfEmptyText")}</p>
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              <Plus />{busy ? t("importing") : t("chooseFiles")}
            </button>
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
                      <strong title={book.title}>{book.title}</strong>
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
        <DeleteDialog
          book={deleteTarget}
          t={t}
          onClose={() => setDeleteTarget(undefined)}
          onConfirm={confirmDelete}
        />
      )}

      {feedbackOpen && <FeedbackDialog language={language} onClose={() => setFeedbackOpen(false)} onSuccess={() => { setFeedbackOpen(false); setMessage(t("feedbackSuccess")); }} />}
    </main>
  );
}
