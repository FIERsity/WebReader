export interface ReaderOutlineItem {
  id: string;
  label: string;
  target?: string;
  children: ReaderOutlineItem[];
}

export interface ReaderSearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

export interface ReaderSearchResult {
  id: string;
  target: string;
  label?: string;
  excerpt: ReaderSearchExcerpt;
}

export interface ReaderSearchOutcome {
  results: ReaderSearchResult[];
  truncated: boolean;
}

export interface ReaderSearchOptions {
  signal: AbortSignal;
  maxResults: number;
  onProgress?: (progress: number) => void;
}

export interface ReaderCapabilities {
  typography: boolean;
  outline: boolean;
  publisherFont: boolean;
  readingProfile: boolean;
  paginated: boolean;
  search: boolean;
}

export interface ReaderController {
  previous: () => void;
  next: () => void;
  goTo?: (target: string) => void;
  search?: (query: string, options: ReaderSearchOptions) => Promise<ReaderSearchOutcome>;
  goToSearch?: (result: ReaderSearchResult) => void;
  clearSearch?: () => void;
}

export const NO_READER_CAPABILITIES: ReaderCapabilities = {
  typography: false,
  outline: false,
  publisherFont: false,
  readingProfile: false,
  paginated: false,
  search: false,
};
