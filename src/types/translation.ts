export type StructuredTextFormat = "txt" | "markdown";
export type StructuredBlockKind = "heading" | "paragraph" | "code";
export type TranslationTargetLanguage = "zh-CN" | "en";

export interface SourceRange {
  start: number;
  end: number;
}

export interface StructuredTextBlock {
  id: string;
  kind: StructuredBlockKind;
  text: string;
  sourceRange: SourceRange;
  headingLevel?: number;
}

export interface StructuredTextDocument {
  version: 1;
  bookId: string;
  format: StructuredTextFormat;
  revision: string;
  blocks: StructuredTextBlock[];
}

export interface TranslationAnchor {
  blockId: string;
  start: number;
  end: number;
}

export interface TranslationCacheRecord {
  key: string;
  bookId: string;
  documentRevision: string;
  sourceHash: string;
  anchor: TranslationAnchor;
  targetLanguage: TranslationTargetLanguage;
  provider: "deepseek";
  model: "deepseek-chat";
  promptVersion: "translate-v1";
  translatedText: string;
  createdAt: number;
  updatedAt: number;
}

export interface TranslationRequest {
  version: 1;
  unit: {
    id: string;
    text: string;
    sourceLanguage: "auto";
  };
  targetLanguage: TranslationTargetLanguage;
}

export interface TranslationResponse {
  version: 1;
  translation: { id: string; text: string };
  provider: "deepseek";
  model: "deepseek-chat";
  promptVersion: "translate-v1";
}
