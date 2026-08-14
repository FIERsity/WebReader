import { expect, test } from "@playwright/test";
import { syntheticEpub, syntheticPdf } from "./syntheticBooks";

test("opens a synthetic EPUB and keeps it readable across mode changes", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.epub",
    mimeType: "application/epub+zip",
    buffer: syntheticEpub(),
  });
  await page.getByRole("button", { name: "打开《synthetic》" }).click();

  await expect(page.locator("foliate-view")).toBeVisible();
  await expect.poll(() => page.locator("foliate-view").evaluate((view) => {
    const renderer = (view as HTMLElement & { renderer?: { getContents?: () => Array<{ doc: Document }> } }).renderer;
    return renderer?.getContents?.().map((content) => content.doc.body.textContent ?? "").join("\n") ?? "";
  })).toContain("这是 WebReader 自动化测试生成的本地 EPUB");
  await expect(page.getByRole("button", { name: "目录" })).toBeEnabled();
  await page.getByRole("button", { name: "滚动" }).click();
  await expect(page.locator("foliate-view")).toBeVisible();
  await page.getByRole("button", { name: "翻页" }).click();
  await expect(page.getByText("无法打开此 EPUB 文件。")).toHaveCount(0);
});

test("opens a synthetic PDF and preserves its page across mode changes", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPdf(),
  });
  await page.getByRole("button", { name: "打开《synthetic》" }).click();

  await expect(page.getByRole("toolbar", { name: "PDF 阅读视图" })).toBeVisible();
  await expect(page.locator(".pdf-page-surface")).toBeVisible();
  await expect.poll(() => page.locator(".pdf-page-surface canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    return context ? context.getImageData(0, 0, 1, 1).data[3] : 0;
  })).toBeGreaterThan(0);
  await expect(page.locator(".page-status")).toHaveText("1 / 1");
  await page.getByRole("button", { name: "滚动" }).click();
  await expect(page.locator(".continuous-pdf-track")).toBeVisible();
  await expect(page.locator(".continuous-pdf-track .pdf-page-surface canvas")).toBeVisible();
  await page.getByRole("button", { name: "翻页" }).click();
  await expect(page.locator(".pdf-page-surface")).toBeVisible();
  await expect(page.getByText("无法渲染此 PDF 页面。")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test("serves an installable application shell without caching imported books", async ({ page }) => {
  await page.goto("/");
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.ready))).toBe(true);

  await page.locator('input[type="file"]').setInputFiles({
    name: "private-synthetic.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPdf(),
  });
  const cachedUrls = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (await Promise.all(keys.map(async (key) => (await caches.open(key)).keys())))
      .flat().map((request) => request.url);
  });
  expect(cachedUrls.some((url) => url.includes("private-synthetic"))).toBe(false);
});
