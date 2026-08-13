import { expect, test } from "@playwright/test";
import path from "node:path";

const fixture = path.join(import.meta.dirname, "fixtures", "long-reader.md");
const emptyFixture = path.join(import.meta.dirname, "fixtures", "empty-reader.txt");
const invalidEpubFixture = path.join(import.meta.dirname, "fixtures", "invalid.epub");

test("imports a local Markdown file and restores its paged position after reload", async ({ page }) => {
  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4175") unexpectedRequests.push(request.url());
  });

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture);

  await expect(page.getByRole("status")).toContainText("已将 1 本书添加到此浏览器");
  await expect(page.getByRole("button", { name: "打开《long reader》" })).toBeVisible();
  await page.getByRole("button", { name: "打开《long reader》" }).click();

  const stage = page.locator(".text-stage-paged");
  await expect(stage).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页" })).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect.poll(() => stage.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })))
    .toMatchObject({ top: 0 });
  await expect.poll(() => stage.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  const savedLeft = await stage.evaluate((element) => element.scrollLeft);
  await page.getByRole("button", { name: "返回书架" }).click();
  await expect(page.getByRole("button", { name: "打开《long reader》" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "打开《long reader》" }).click();

  await expect.poll(() => page.locator(".text-stage-paged").evaluate((element) => element.scrollLeft))
    .toBeGreaterThanOrEqual(savedLeft);
  expect(unexpectedRequests).toEqual([]);
});

test("reports empty text and rejects a renamed ZIP before it reaches the shelf", async ({ page }) => {
  await page.goto("/");
  const input = page.locator('input[type="file"]');

  await input.setInputFiles(emptyFixture);
  await expect(page.getByRole("button", { name: "打开《empty reader》" })).toBeVisible();
  await page.getByRole("button", { name: "打开《empty reader》" }).click();
  await expect(page.getByText("这个文本文件没有可显示的内容。")).toBeVisible();
  await page.getByRole("button", { name: "返回书架" }).click();

  await input.setInputFiles(invalidEpubFixture);
  await expect(page.getByRole("status")).toContainText("此文件不是有效的 DRM-free EPUB");
  await expect(page.getByRole("button", { name: /打开《invalid》/ })).toHaveCount(0);
});
