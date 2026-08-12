export interface ReaderOutlineItem {
  id: string;
  label: string;
  target?: string;
  children: ReaderOutlineItem[];
}

export interface ReaderCapabilities {
  typography: boolean;
  outline: boolean;
  publisherFont: boolean;
}

export interface ReaderController {
  previous: () => void;
  next: () => void;
  goTo?: (target: string) => void;
}

export const NO_READER_CAPABILITIES: ReaderCapabilities = {
  typography: false,
  outline: false,
  publisherFont: false,
};
