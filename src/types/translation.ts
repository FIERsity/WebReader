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

export type PaperTranslationProviderId = "openai" | "anthropic" | "deepseek" | "custom-openai";
export type PaperTranslationJobStatus = "queued" | "running" | "paused-needs-key" | "completed" | "failed" | "cancelled";
export type PaperTranslationBatchStatus = "queued" | "running" | "completed" | "failed";

export interface PaperTranslationProviderConfig {
  provider: PaperTranslationProviderId;
  model: string;
  endpoint?: string;
  apiKey: string;
}

export interface PaperTranslationUnit {
  id: string;
  text: string;
  kind: string;
  section?: string;
}

export interface PaperTranslationJob {
  id: string;
  bookId: string;
  documentRevision: string;
  segmenterVersion: number;
  promptVersion: string;
  manifestHash: string;
  provider: PaperTranslationProviderId;
  model: string;
  endpoint?: string;
  targetLanguage: TranslationTargetLanguage;
  status: PaperTranslationJobStatus;
  totalUnits: number;
  completedUnits: number;
  batchCount: number;
  completedBatches: number;
  createdAt: number;
  updatedAt: number;
  lastErrorCode?: string;
}

export interface PaperTranslationBatch {
  id: string;
  jobId: string;
  bookId: string;
  ordinal: number;
  unitIds: string[];
  status: PaperTranslationBatchStatus;
  attempt: number;
  updatedAt: number;
  errorCode?: string;
}

export interface PaperTranslationResult {
  key: string;
  jobId: string;
  bookId: string;
  blockId: string;
  sourceHash: string;
  translatedText: string;
  createdAt: number;
  updatedAt: number;
}
