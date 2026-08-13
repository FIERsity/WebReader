# WebReader

A private-by-default bilingual web reader for local books. The interface supports 中文 and English and defaults to Chinese. Import DRM-free EPUB, PDF, TXT, or Markdown files and read them without uploading book content to a server.

Production: https://FIERsity.github.io/WebReader/

## Current Features

- Local library persisted in IndexedDB, with a per-document Book/Paper reading profile
- EPUB reading with paginated navigation, chapter-continuous Paper mode, nested table of contents, and CFI progress
- PDF rendering with PDF.js, selectable text over the authoritative Canvas, document outlines, page progress, and a windowed continuous-page Paper mode
- Local PDF article reflow for text-layer papers, with deterministic single-column reading order, per-page diagnostics, and a side-by-side proof view
- Stable source-block mapping between reflowed text and the authoritative PDF Canvas/TextLayer
- TXT and Markdown-as-text reading with UTF-8/GB18030 fallback, local heading outlines, and continuous Paper mode
- Mouse-wheel page turns in Book mode, with trackpad gesture locking and native scrolling in Paper mode
- Chinese/English interface with a locally remembered language choice
- Reading controls for text size, local font stacks, line spacing, first-line indent, text width, and four background themes
- Keyboard navigation for page turns, contents, text size, and panel dismissal
- Explicit text-only feedback submission to the developer's feedback server
- Duplicate detection, local deletion, a 250 MB per-file safety limit for EPUB/PDF, and an 8 MB limit for browser-rendered TXT/Markdown
- Installable PWA application shell
- Fully static GitHub Pages deployment

Books, extracted content, reading progress, and preferences remain in the current browser. Clearing site data can remove the local library. PWA installation is not a backup. For a text-layer PDF, **Reflowed article** analyzes text locally and reconstructs a continuous single-column reading order without an LLM. **Proof view** places each original PDF page beside the blocks assigned to that page so column order, omissions, headers, footers, equations, and references can be checked against the visual source.

The original PDF Canvas remains authoritative. Its PDF.js text layer is selectable and maps selections to stable source blocks. Selecting a reflowed block records its source page and region, so returning to the original PDF highlights the corresponding geometry. Review and rejected pages are reported explicitly; scanned PDFs without a usable text layer still require OCR, which WebReader does not currently provide. Whole-paper remote translation is temporarily unavailable while source reconstruction is being validated. Existing local translation records are left intact but are not shown or resumed.

## Development

Requires Node.js 24 or newer.

```bash
npm ci
npm run dev
npm run check
npm run preview
```

`npm run check` runs unit tests, lint, TypeScript, and the production build.

### Local Paper Reflow

The current paper tool is fully local and deterministic. It uses PDF.js text items, coordinates, font geometry, column detection, line joining, repeated-margin detection, and conservative block classification. It does not call a model or provider, and it does not invent text for pages whose text layer cannot be reconstructed. The first version supports text-layer PDFs only; OCR, editable ordering, export, and formula-to-LaTeX conversion are not yet included.

The local development DeepSeek paragraph experiment for TXT/Markdown remains available through the loopback-only proxy:

```bash
DEEPSEEK_API_KEY="..." npm run dev
```

Do not put a key in a `VITE_*` variable, source file, `.env` file, browser storage, or Git.

## Deployment

Pushes to `main` run checks and publish `dist/` through GitHub Actions to GitHub Pages. GitHub Actions is used only for CI/CD; the application has no server process.

The production build uses relative paths so application chunks, PDF workers, the manifest, and the service worker resolve correctly beneath `/WebReader/`.

## Privacy And Security

- No accounts, analytics, telemetry, cloud storage, runtime CDN, or remote metadata lookups
- Feedback is an explicit text-only request to `feedback.070315.site`, limited to 2000 characters. The service retains necessary connection details for rate limiting and abuse prevention; do not include sensitive information
- Ordinary reading, importing, progress updates, and PDF reflow send no book text over the network
- Whole-paper remote translation controls and the production translation runtime are currently disabled
- Source books are stored in browser IndexedDB and never included in GitHub artifacts
- EPUB scripted content and external network access are blocked by Content Security Policy
- PDF files use worker-backed Canvas rendering as the authoritative source, with an official PDF.js TextLayer overlay for local selection. Continuous mode mounts only a bounded page window, and WebReader does not create PDF scripting managers, sandboxes, or run document JavaScript actions. Bounded local analysis preserves source-item provenance and stable block IDs for alignment
- Paper mode is format-aware: reflowable EPUB is continuous within each chapter and advances at chapter boundaries; fixed-layout EPUB remains paginated
- Reader fonts use local system stacks or fonts embedded by the publisher; WebReader does not fetch remote fonts
- Extensions and MIME types are checked alongside file signatures where available

Only use books you have the right to read. WebReader does not implement or circumvent DRM.

## License

MIT. Third-party packages remain under their respective licenses.
