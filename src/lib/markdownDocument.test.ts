import { describe, expect, it } from "vitest";
import { parseMarkdownBlock, parseMarkdownInline } from "./markdownDocument";
import { splitTextBlocks } from "./textDocument";

describe("safe Markdown document parsing", () => {
  it("keeps visible inline nodes tied to their original source ranges", () => {
    const nodes = parseMarkdownInline("A **bold** and [link](https://example.com)", 10);
    expect(nodes).toMatchObject([
      { type: "text", start: 10, end: 12, text: "A " },
      {
        type: "strong",
        start: 12,
        end: 20,
        children: [{ type: "text", start: 14, end: 18, text: "bold" }],
      },
      { type: "text", start: 20, end: 25, text: " and " },
      {
        type: "link",
        start: 25,
        end: 52,
        children: [{ type: "text", start: 26, end: 30, text: "link" }],
      },
    ]);
  });

  it("renders blocks as semantic Markdown kinds without allowing raw HTML or unsafe links", () => {
    const source = "# Title\n\n- One\n- Two **bold**\n\n> Quote\n\n<script>alert(1)</script> [unsafe](javascript:alert(1))";
    const blocks = splitTextBlocks(source).map(parseMarkdownBlock);
    expect(blocks.map((block) => block.markdownKind)).toEqual(["heading", "list", "quote", "paragraph"]);
    expect(blocks[0]?.headingLevel).toBe(1);
    expect(blocks[1]?.listItems?.[0]?.lines[0]).toMatchObject([{ type: "text", text: "One" }]);
    expect(blocks[1]?.listItems?.[1]?.lines[0]).toMatchObject([
      { type: "text", text: "Two " },
      { type: "strong" },
    ]);
    expect(blocks[3]?.inlineNodes?.some((node) => node.type === "link")).toBe(false);
    expect(blocks[3]?.inlineNodes?.some((node) => node.type === "text" && node.text.includes("<script>"))).toBe(true);
  });

  it("keeps fenced code literal and maps it to the source after the fence", () => {
    const block = parseMarkdownBlock(splitTextBlocks("```ts\nconst value = 1;\n```\n")[0]!);
    expect(block.markdownKind).toBe("code");
    expect(block.codeLanguage).toBe("ts");
    expect(block.codeText).toBe("const value = 1;\n");
    expect(block.codeStart).toBe(6);
    expect(block.codeEnd).toBe(23);
  });

  it("recognizes setext headings and safely downgrades images to alt text", () => {
    const heading = parseMarkdownBlock(splitTextBlocks("Heading\n=======\n")[0]!);
    expect(heading).toMatchObject({ markdownKind: "heading", headingLevel: 1 });

    const image = parseMarkdownInline("![cover](https://example.com/cover.png)");
    expect(image).toMatchObject([{ type: "image", alt: "cover", altStart: 2, altEnd: 7 }]);
  });
});
