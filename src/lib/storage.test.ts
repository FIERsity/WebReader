import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BookRecord, ReadingLocator } from "../types/library";
import { DEFAULT_PREFERENCES } from "../types/library";
import {
  db, findByFingerprint, getBookFile, getPreferences, listBooks, removeBook, saveBook, savePreferences,
  updateLocator, updateReadingProfile,
} from "./storage";

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

  it("removes legacy translation records with their parent book", async () => {
    const book = record();
    await saveBook(book, new File(["fixture"], book.fileName));
    const jobId = "legacy-job";
    await db.transaction("rw", [db.translations, db.translationJobs, db.translationBatches, db.translationResults], async () => {
      await db.translations.put({ key: "legacy-unit", bookId: book.id });
      await db.translationJobs.put({ id: jobId, bookId: book.id });
      await db.translationBatches.put({ id: "legacy-batch", jobId, bookId: book.id });
      await db.translationResults.put({ key: "legacy-result", jobId, bookId: book.id });
    });

    await removeBook(book.id);

    expect(await db.translations.count()).toBe(0);
    expect(await db.translationJobs.count()).toBe(0);
    expect(await db.translationBatches.count()).toBe(0);
    expect(await db.translationResults.count()).toBe(0);
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

  it("opens version 2 databases without changing their books", async () => {
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
