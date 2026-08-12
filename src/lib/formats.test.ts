import { describe, expect, it } from "vitest";
import { detectBookFormat, displayTitle, formatBytes, MAX_FILE_SIZE } from "./formats";

function file(bytes: number[], name: string, type = ""): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("detectBookFormat", () => {
  it("requires both a PDF signature and a PDF hint", async () => {
    await expect(detectBookFormat(file([0x25, 0x50, 0x44, 0x46, 0x2d], "book.pdf"))).resolves.toBe("pdf");
    await expect(detectBookFormat(file([0x25, 0x50, 0x44, 0x46, 0x2d], "book.txt"))).resolves.toBe("txt");
  });

  it("accepts a ZIP signature only when identified as EPUB", async () => {
    const zip = [0x50, 0x4b, 0x03, 0x04];
    await expect(detectBookFormat(file(zip, "book.epub"))).resolves.toBe("epub");
    await expect(detectBookFormat(file(zip, "archive.zip"))).rejects.toMatchObject({ translationKey: "unsupportedFormat" });
  });

  it("rejects empty and oversized files", async () => {
    await expect(detectBookFormat(new File([], "empty.txt", { type: "text/plain" }))).rejects.toMatchObject({ translationKey: "emptyFile" });
    const oversized = { name: "large.pdf", type: "application/pdf", size: MAX_FILE_SIZE + 1 } as File;
    await expect(detectBookFormat(oversized)).rejects.toMatchObject({ translationKey: "fileTooLarge" });
  });
});

describe("display helpers", () => {
  it("derives a readable title", () => expect(displayTitle("the_left-hand.epub")).toBe("the left hand"));
  it("formats file sizes", () => {
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
