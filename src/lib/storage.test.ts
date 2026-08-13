import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BookRecord, ReadingLocator } from "../types/library";
import type { PaperTranslationBatch, PaperTranslationJob, PaperTranslationProviderConfig } from "../types/translation";
import { DEFAULT_PREFERENCES } from "../types/library";
import {
  completePaperTranslationBatch, createPaperTranslationJob, db, findByFingerprint, getBookFile, getPaperTranslationJob,
  getPreferences, getTranslation, listBooks, listPaperTranslationBatches, listPaperTranslationResults, listTranslations,
  putTranslation, removeBook, saveBook, savePreferences, updateLocator, updateReadingProfile,
} from "./storage";
import { createTranslationCacheRecord } from "./translation";

function record(): BookRecord {
  return {
    id: "book-1",
    fingerprint: "fingerprint-1",
    title: "Fixture",
    format: "txt",
    readingProfile: "book",
    fileName: "fixture.txt",
    mediaType: "text/plain",
    size: 7,
    addedAt: 10,
    updatedAt: 10,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  db.close();
});

describe("local book repository", () => {
  it("stores metadata and source bytes together and removes both", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName, { type: book.mediaType }));

    expect(await listBooks()).toEqual([book]);
    expect(await findByFingerprint(book.fingerprint)).toEqual(book);
    expect(await (await getBookFile(book.id)).text()).toBe("fixture");

    await removeBook(book.id);
    expect(await listBooks()).toEqual([]);
    await expect(getBookFile(book.id)).rejects.toThrow(/missing/);
  });

  it("updates format-specific progress without replacing the source file", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName));
    const locator: ReadingLocator = { type: "text", value: "4", progression: 0.5, label: "50%" };
    await updateLocator(book.id, locator);

    expect((await listBooks())[0]?.locator).toEqual(locator);
    expect(await (await getBookFile(book.id)).text()).toBe("fixture");
  });

  it("updates the reading profile without replacing progress or source bytes", async () => {
    const book = record();
    const locator: ReadingLocator = { type: "text", value: "3", progression: 0.4 };
    await saveBook({ ...book, locator }, new File(["fixture"], book.fileName));
    await updateReadingProfile(book.id, "article");

    const updated = (await listBooks())[0];
    expect(updated?.readingProfile).toBe("article");
    expect(updated?.locator).toEqual(locator);
    expect(await (await getBookFile(book.id)).text()).toBe("fixture");
  });

  it("stores and cascades versioned translation cache records", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName));
    const translation = await createTranslationCacheRecord({
      bookId: book.id,
      documentRevision: "revision-1",
      blockId: "paragraph:0:7",
      blockText: "fixture",
      targetLanguage: "zh-CN",
      translatedText: "测试文本",
      now: 12,
    });
    await putTranslation(translation);

    expect(await getTranslation(translation.key)).toEqual(translation);
    expect(await listTranslations(book.id, "revision-1", "zh-CN")).toEqual([translation]);
    expect(await listTranslations(book.id, "revision-1", "en")).toEqual([]);

    await removeBook(book.id);
    expect(await getTranslation(translation.key)).toBeUndefined();
  });

  it("stores recoverable paper jobs and cascades batches and results", async () => {
    const book = { ...record(), format: "pdf" as const };
    await saveBook(book, new File(["%PDF fixture"], "fixture.pdf"));
    const job: PaperTranslationJob = {
      id: "job-1", bookId: book.id, documentRevision: "pdf-v2", segmenterVersion: 2,
      promptVersion: "paper-v1", manifestHash: "manifest",
      provider: "deepseek", model: "deepseek-chat", targetLanguage: "zh-CN", status: "queued",
      totalUnits: 1, completedUnits: 0, batchCount: 1, completedBatches: 0, createdAt: 20, updatedAt: 20,
    };
    const batch: PaperTranslationBatch = {
      id: "batch-1", jobId: job.id, bookId: book.id, ordinal: 0, unitIds: ["block-1"],
      status: "queued", attempt: 0, updatedAt: 20,
    };
    expect(await createPaperTranslationJob(job, [batch])).toBe(true);
    await completePaperTranslationBatch({
      jobId: job.id, batchId: batch.id, completedUnits: 1, completedBatches: 1,
      results: [{
        key: "job-1:block-1", jobId: job.id, bookId: book.id, blockId: "block-1",
        sourceHash: "source-hash", translatedText: "译文", createdAt: 21, updatedAt: 21,
      }],
    });

    const serialized = JSON.stringify({
      job: await getPaperTranslationJob(job.id),
      batches: await listPaperTranslationBatches(job.id),
      results: await listPaperTranslationResults(job.id),
    });
    expect(serialized).toContain("译文");
    expect(serialized).not.toMatch(/api.?key|authorization|secret/i);

    await removeBook(book.id);
    expect(await getPaperTranslationJob(job.id)).toBeUndefined();
    expect(await listPaperTranslationBatches(job.id)).toEqual([]);
    expect(await listPaperTranslationResults(job.id)).toEqual([]);
  });

  it("never includes provider credentials in persisted job fields", () => {
    const config: PaperTranslationProviderConfig = { provider: "openai", model: "gpt-4.1-mini", apiKey: "memory-only" };
    const persisted = { provider: config.provider, model: config.model };
    expect(JSON.stringify(persisted)).not.toContain(config.apiKey);
  });

  it("does not recreate translation cache after its parent book is removed", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName));
    const translation = await createTranslationCacheRecord({
      bookId: book.id, documentRevision: "revision-1", blockId: "paragraph:0:7",
      blockText: "fixture", targetLanguage: "en", translatedText: "fixture",
    });
    await removeBook(book.id);
    expect(await putTranslation(translation)).toBe(false);
    expect(await getTranslation(translation.key)).toBeUndefined();
  });

  it("upgrades version 1 books without changing their source or locator", async () => {
    db.close();
    await db.delete();
    const legacy = new Dexie("webreader");
    legacy.version(1).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format",
      files: "bookId",
      settings: "key",
    });
    await legacy.open();
    const book = record();
    const locator: ReadingLocator = { type: "text", value: "5", progression: 0.7 };
    const { readingProfile: _readingProfile, ...legacyBook } = { ...book, locator };
    await legacy.transaction("rw", legacy.table("books"), legacy.table("files"), async () => {
      await legacy.table("books").put(legacyBook);
      await legacy.table("files").put({ bookId: book.id, blob: new Blob(["legacy"]) });
    });
    legacy.close();

    await db.open();
    const migrated = (await listBooks())[0];
    expect(migrated?.readingProfile).toBe("book");
    expect(migrated?.locator).toEqual(locator);
    expect(await (await getBookFile(book.id)).text()).toBe("legacy");
  });

  it("upgrades version 2 databases by adding an empty translation store", async () => {
    db.close();
    await db.delete();
    const previous = new Dexie("webreader");
    previous.version(2).stores({
      books: "id, &fingerprint, addedAt, updatedAt, format, readingProfile",
      files: "bookId",
      settings: "key",
    });
    await previous.open();
    const book = { ...record(), readingProfile: "article" as const };
    await previous.transaction("rw", previous.table("books"), previous.table("files"), async () => {
      await previous.table("books").put(book);
      await previous.table("files").put({ bookId: book.id, blob: new Blob(["version-2"]) });
    });
    previous.close();

    await db.open();
    expect((await listBooks())[0]?.readingProfile).toBe("article");
    expect(await (await getBookFile(book.id)).text()).toBe("version-2");
    expect(await db.translations.count()).toBe(0);
  });

  it("migrates stored preferences to current defaults", async () => {
    await db.settings.put({ key: "reader-preferences", value: { theme: "night", fontScale: 1.2, lineHeight: 1.8 } });
    expect(await getPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "night",
      fontSizePercent: 120,
      lineHeight: 1.9,
    });

    await savePreferences({ ...DEFAULT_PREFERENCES, theme: "white", fontFamily: "sans" });
    expect(await getPreferences()).toEqual({ ...DEFAULT_PREFERENCES, theme: "white", fontFamily: "sans" });
  });
});
