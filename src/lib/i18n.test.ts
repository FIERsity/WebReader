import { describe, expect, it } from "vitest";
import { resolveLanguage, translate } from "./i18n";

describe("i18n", () => {
  it("defaults to Chinese and restores an explicit English preference", () => {
    expect(resolveLanguage(null)).toBe("zh");
    expect(resolveLanguage("zh")).toBe("zh");
    expect(resolveLanguage("en")).toBe("en");
  });

  it("translates variables in both languages", () => {
    expect(translate("zh", "percentRead", { percent: 42 })).toBe("已读 42%");
    expect(translate("en", "percentRead", { percent: 42 })).toBe("42% read");
  });
});
