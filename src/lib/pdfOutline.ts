import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ReaderOutlineItem } from "../types/reader";

type PdfOutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

async function destinationPage(pdf: PDFDocumentProxy, destination: PdfOutlineNode["dest"]): Promise<number | undefined> {
  const resolved = typeof destination === "string" ? await pdf.getDestination(destination) : destination;
  if (!resolved || resolved.length === 0) return undefined;
  const reference = resolved[0];
  if (typeof reference === "number") return reference + 1;
  try {
    return (await pdf.getPageIndex(reference)) + 1;
  } catch {
    return undefined;
  }
}

async function normalizeNodes(pdf: PDFDocumentProxy, nodes: PdfOutlineNode[], path: string): Promise<ReaderOutlineItem[]> {
  return Promise.all(nodes.map(async (node, index) => {
    const page = node.url ? undefined : await destinationPage(pdf, node.dest);
    return {
      id: `${path}-${index}`,
      label: node.title?.trim() || "…",
      target: page ? String(page) : undefined,
      children: await normalizeNodes(pdf, node.items ?? [], `${path}-${index}`),
    };
  }));
}

export async function getPdfOutline(pdf: PDFDocumentProxy): Promise<ReaderOutlineItem[]> {
  const outline = await pdf.getOutline();
  return normalizeNodes(pdf, outline ?? [], "pdf");
}
