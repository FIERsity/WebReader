# WebReader

A private-by-default bilingual web reader for local books. The interface supports 中文 and English and defaults to Chinese. Import DRM-free EPUB, PDF, TXT, or Markdown files and read them without uploading book content to a server.

Production: https://FIERsity.github.io/WebReader/

## Current Features

- Local library persisted in IndexedDB, with a per-document Book/Paper reading profile
- EPUB reading with paginated navigation, chapter-continuous Paper mode, nested table of contents, and CFI progress
- PDF rendering with PDF.js, selectable text over the authoritative Canvas, document outlines, page progress, and a windowed continuous-page Paper mode
- One-command whole-paper translation for text-layer PDFs with OpenAI, Anthropic, DeepSeek, or a custom OpenAI-compatible HTTPS endpoint
- Recoverable local translation jobs, bounded dynamic batches, strict source-block ID validation, protected citations/URLs/variables, and in-memory API keys
- Side-by-side source/translation reading with one aligned grid row per source block, original page visuals, counterpart block highlighting, and a translation-only mode
- TXT and Markdown-as-text reading with UTF-8/GB18030 fallback, local heading outlines, and continuous Paper mode
- Mouse-wheel page turns in Book mode, with trackpad gesture locking and native scrolling in Paper mode
- Chinese/English interface with a locally remembered language choice
- Reading controls for text size, local font stacks, line spacing, first-line indent, text width, and four background themes
- Keyboard navigation for page turns, contents, text size, and panel dismissal
- Explicit text-only feedback submission to the developer's feedback server
- Duplicate detection, local deletion, a 250 MB per-file safety limit for EPUB/PDF, and an 8 MB limit for browser-rendered TXT/Markdown
- Installable PWA application shell
- Fully static GitHub Pages deployment

Books, extracted content, reading progress, and preferences remain in the current browser during ordinary reading. Clearing site data can remove the local library. PWA installation is not a backup. For a text-layer PDF, clicking **Translate paper** runs bounded local extraction, asks the user to choose a provider/model and target language, and displays the exact destination host, block count, and source character estimate before anything is sent. After confirmation, immutable source blocks are grouped into small dynamic requests and sent directly from an isolated translation runtime to the selected provider. The API key remains only in current-tab memory; it is not stored in IndexedDB, Cache Storage, the service worker, source, logs, or URLs. Validated tasks, batches, and translations are stored locally so an interrupted paper can resume after the user re-enters a key.

The original PDF Canvas remains authoritative. Its PDF.js text layer is selectable and maps selections to stable source blocks. The paired view keeps each source block and its translation in the same grid row, leaving blank space on the shorter side when necessary. Selecting text on either side highlights the corresponding whole block on the other side; this is block-level alignment, not claimed word-level semantic alignment. Equations and bibliography entries remain verbatim by default, captions are translated, and an original page preview preserves figures, tables, formulas, and layout context. Scanned PDFs without a usable text layer still require OCR, which WebReader does not currently provide.

## Development

Requires Node.js 24 or newer.

```bash
npm ci
npm run dev
npm run check
npm run preview
```

`npm run check` runs unit tests, lint, TypeScript, and the production build.

### Translation Providers

Production paper translation is BYOK and runs only after an explicit whole-paper confirmation. Presets use separate protocol adapters rather than pretending every provider has the same API:

- OpenAI Responses API
- Anthropic Messages API
- DeepSeek Chat Completions API
- Custom OpenAI-compatible Chat Completions endpoint over HTTPS

A ChatGPT or Claude web subscription generally does not include API usage. The selected provider may charge its normal API rates and receives the confirmed paper text batches under its own data policy. Browser-direct requests depend on the provider's CORS support for the WebReader Pages origin. The translation runtime uses a separate entry, bundle, CSP, and private MessageChannel, but it remains same-origin so static Pages can load its module; this is a capability boundary, not protection from compromised same-origin code, browser extensions, or developer tools. Use a revocable temporary API key. If a provider blocks browser access, use a compatible HTTPS endpoint that explicitly permits the WebReader origin, or a future local companion/controlled backend; WebReader does not weaken the main reader CSP or host a shared secret.

The local development DeepSeek paragraph experiment remains available through the loopback-only proxy:

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
- Ordinary reading, importing, progress updates, and PDF selection send no book text over the network. Whole-paper text is sent only after the provider, destination host, scale, and cost risk are explicitly confirmed
- API keys stay in current-tab memory. Recoverable job metadata and validated translations are local; deleting a book cascades its jobs, batches, and results
- The main reader CSP remains restricted. Provider networking runs in an isolated same-origin iframe with a translation-only CSP; arbitrary custom endpoints must use HTTPS and still depend on browser CORS
- Source books are stored in browser IndexedDB and never included in GitHub artifacts
- EPUB scripted content and external network access are blocked by Content Security Policy
- PDF files use worker-backed Canvas rendering as the authoritative source, with an official PDF.js TextLayer overlay for local selection. Continuous mode mounts only a bounded page window, and WebReader does not create PDF scripting managers, sandboxes, or run document JavaScript actions. Bounded local analysis preserves source-item provenance and stable block IDs for alignment
- Paper mode is format-aware: reflowable EPUB is continuous within each chapter and advances at chapter boundaries; fixed-layout EPUB remains paginated
- Reader fonts use local system stacks or fonts embedded by the publisher; WebReader does not fetch remote fonts
- Extensions and MIME types are checked alongside file signatures where available

Only use books you have the right to read. WebReader does not implement or circumvent DRM.

## License

MIT. Third-party packages remain under their respective licenses.
