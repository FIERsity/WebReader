import Dexie, { type EntityTable } from "dexie";
import type { BookRecord, ReaderPreferences, ReadingLocator, ReadingProfile } from "../types/library";
import type {
  PaperTranslationBatch, PaperTranslationJob, PaperTranslationResult,
  TranslationCacheRecord, TranslationTargetLanguage,
} from "../types/translation";
import { normalizePreferences } from "./preferences";

interface FileRecord {
  bookId: string;
  blob: Blob;
}

interface SettingRecord {
  key: string;
  value: unknown;
}

class WebReaderDatabase extends Dexie {
  books!: EntityTable<BookRecord, "id">;
  files!: EntityTable<FileRecord, "bookId">;
  settings!: EntityTable<SettingRecord, "key">;
  translations!: EntityTable<TranslationCacheRecord, "key">;
  translationJobs!: EntityTable<PaperTranslationJob, "id">;
  translationBatches!: EntityTable<PaperTranslationBatch, "id">;
  translationResults!: EntityTable<PaperTranslationResult, "key">;

  constructor() {
    super("webreader");
    this.version(1).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format",
      files: "bookId",
      settings: "key",
    });
    this.version(2).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format, readingProfile",
      files: "bookId",
      settings: "key",
    }).upgrade(async (transaction) => {
      await transaction.table<BookRecord>("books").toCollection().modify((book) => {
        book.readingProfile = book.readingProfile === "article" ? "article" : "book";
      });
    });
    this.version(3).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format, readingProfile",
      files: "bookId",
      settings: "key",
      translations: "&key, bookId, [bookId+documentRevision+targetLanguage], updatedAt",
    });
    this.version(4).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format, readingProfile",
      files: "bookId",
      settings: "key",
      translations: "&key, bookId, [bookId+documentRevision+targetLanguage], updatedAt",
      translationJobs: "&id, bookId, [bookId+documentRevision], status, updatedAt",
      translationBatches: "&id, jobId, bookId, [jobId+ordinal], status, updatedAt",
      translationResults: "&key, jobId, bookId, [jobId+blockId], updatedAt",
    });
  }
}

export const db = new WebReaderDatabase();

export async function listBooks(): Promise<BookRecord[]> {
  return db.books.orderBy("updatedAt").reverse().toArray();
}

export async function saveBook(book: BookRecord, file: File): Promise<void> {
  await db.transaction("rw", db.books, db.files, async () => {
    await db.books.put(book);
    await db.files.put({ bookId: book.id, blob: file });
  });
}

export async function findByFingerprint(fingerprint: string): Promise<BookRecord | undefined> {
  return db.books.where("fingerprint").equals(fingerprint).first();
}

export async function getBookFile(bookId: string): Promise<Blob> {
  const record = await db.files.get(bookId);
  if (!record) throw new Error("The local book file is missing. Re-import the original file.");
  return record.blob;
}

export async function updateLocator(bookId: string, locator: ReadingLocator): Promise<void> {
  await db.books.update(bookId, { locator, updatedAt: Date.now() });
}

export async function updateReadingProfile(bookId: string, readingProfile: ReadingProfile): Promise<void> {
  await db.books.update(bookId, { readingProfile });
}

export async function getTranslation(key: string): Promise<TranslationCacheRecord | undefined> {
  return db.translations.get(key);
}

export async function listTranslations(
  bookId: string,
  documentRevision: string,
  targetLanguage: TranslationTargetLanguage,
): Promise<TranslationCacheRecord[]> {
  return db.translations.where("[bookId+documentRevision+targetLanguage]")
    .equals([bookId, documentRevision, targetLanguage]).toArray();
}

export async function putTranslation(record: TranslationCacheRecord): Promise<boolean> {
  return db.transaction("rw", db.books, db.translations, async () => {
    if (!await db.books.get(record.bookId)) return false;
    await db.translations.put(record);
    return true;
  });
}

export async function listPaperTranslationJobs(bookId: string, documentRevision: string): Promise<PaperTranslationJob[]> {
  return db.translationJobs.where("[bookId+documentRevision]").equals([bookId, documentRevision]).reverse().sortBy("updatedAt");
}

export async function getPaperTranslationJob(jobId: string): Promise<PaperTranslationJob | undefined> {
  return db.translationJobs.get(jobId);
}

export async function createPaperTranslationJob(
  job: PaperTranslationJob,
  batches: PaperTranslationBatch[],
): Promise<boolean> {
  return db.transaction("rw", db.books, db.translationJobs, db.translationBatches, async () => {
    if (!await db.books.get(job.bookId)) return false;
    await db.translationJobs.add(job);
    await db.translationBatches.bulkAdd(batches);
    return true;
  });
}

export async function listPaperTranslationBatches(jobId: string): Promise<PaperTranslationBatch[]> {
  return db.translationBatches.where("jobId").equals(jobId).sortBy("ordinal");
}

export async function listPaperTranslationResults(jobId: string): Promise<PaperTranslationResult[]> {
  return db.translationResults.where("jobId").equals(jobId).toArray();
}

export async function resumePaperTranslationJob(jobId: string): Promise<boolean> {
  return db.transaction("rw", db.translationJobs, db.translationBatches, async () => {
    const job = await db.translationJobs.get(jobId);
    if (!job) return false;
    await db.translationBatches.where("jobId").equals(jobId).filter((batch) => batch.status === "running" || batch.status === "failed")
      .modify({ status: "queued", errorCode: undefined, updatedAt: Date.now() });
    await db.translationJobs.update(jobId, { status: "running", lastErrorCode: undefined, updatedAt: Date.now() });
    return true;
  });
}

export async function pausePaperTranslationJob(input: {
  jobId: string;
  status: PaperTranslationJob["status"];
  errorCode: string;
  activeBatchId?: string;
  batchStatus?: PaperTranslationBatch["status"];
  batchAttempt?: number;
}): Promise<boolean> {
  return db.transaction("rw", db.translationJobs, db.translationBatches, async () => {
    if (!await db.translationJobs.get(input.jobId)) return false;
    await db.translationBatches.where("jobId").equals(input.jobId).filter((batch) => batch.status === "running")
      .modify({ status: "queued", updatedAt: Date.now() });
    if (input.activeBatchId && input.batchStatus) {
      await db.translationBatches.update(input.activeBatchId, {
        status: input.batchStatus,
        errorCode: input.errorCode,
        attempt: input.batchAttempt,
        updatedAt: Date.now(),
      });
    }
    await db.translationJobs.update(input.jobId, {
      status: input.status, lastErrorCode: input.errorCode, updatedAt: Date.now(),
    });
    return true;
  });
}

export async function updatePaperTranslationJob(jobId: string, changes: Partial<PaperTranslationJob>): Promise<void> {
  await db.translationJobs.update(jobId, { ...changes, updatedAt: Date.now() });
}

export async function updatePaperTranslationBatch(jobId: string, batchId: string, changes: Partial<PaperTranslationBatch>): Promise<boolean> {
  return db.transaction("rw", db.translationJobs, db.translationBatches, async () => {
    if (!await db.translationJobs.get(jobId)) return false;
    return Boolean(await db.translationBatches.update(batchId, { ...changes, updatedAt: Date.now() }));
  });
}

export async function completePaperTranslationBatch(input: {
  jobId: string;
  batchId: string;
  results: PaperTranslationResult[];
  completedUnits: number;
  completedBatches: number;
}): Promise<boolean> {
  return db.transaction("rw", db.books, db.translationJobs, db.translationBatches, db.translationResults, async () => {
    const job = await db.translationJobs.get(input.jobId);
    if (!job || !await db.books.get(job.bookId)) return false;
    await db.translationResults.bulkPut(input.results);
    await db.translationBatches.update(input.batchId, { status: "completed", updatedAt: Date.now(), errorCode: undefined });
    await db.translationJobs.update(input.jobId, {
      completedUnits: input.completedUnits,
      completedBatches: input.completedBatches,
      updatedAt: Date.now(),
    });
    return true;
  });
}

export async function removeBook(bookId: string): Promise<void> {
  await db.transaction(
    "rw", [db.books, db.files, db.translations, db.translationJobs, db.translationBatches, db.translationResults],
    async () => {
      const jobIds = await db.translationJobs.where("bookId").equals(bookId).primaryKeys();
      await db.books.delete(bookId);
      await db.files.delete(bookId);
      await db.translations.where("bookId").equals(bookId).delete();
      await db.translationJobs.where("bookId").equals(bookId).delete();
      await db.translationBatches.where("bookId").equals(bookId).delete();
      await db.translationResults.where("bookId").equals(bookId).delete();
      if (jobIds.length > 0) {
        await db.translationBatches.where("jobId").anyOf(jobIds).delete();
        await db.translationResults.where("jobId").anyOf(jobIds).delete();
      }
    },
  );
}

export async function getPreferences(): Promise<ReaderPreferences> {
  const record = await db.settings.get("reader-preferences");
  return normalizePreferences(record?.value);
}

export async function savePreferences(preferences: ReaderPreferences): Promise<void> {
  await db.settings.put({ key: "reader-preferences", value: normalizePreferences(preferences) });
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
