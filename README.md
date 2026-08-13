# WebReader

A private-by-default bilingual web reader for local books. The interface supports 中文 and English and defaults to Chinese. Import DRM-free EPUB, PDF, TXT, or Markdown files and read them without uploading book content to a server.

Production: https://FIERsity.github.io/WebReader/

## Current Features

- Local library persisted in IndexedDB, with a per-document Book/Paper reading profile
- EPUB reading with paginated navigation, chapter-continuous Paper mode, nested table of contents, and CFI progress
- PDF rendering with PDF.js, document outlines, page progress, and a windowed continuous-page Paper mode
- TXT and Markdown-as-text reading with UTF-8/GB18030 fallback, local heading outlines, and continuous Paper mode
- Mouse-wheel page turns in Book mode, with trackpad gesture locking and native scrolling in Paper mode
- Chinese/English interface with a locally remembered language choice
- Reading controls for text size, local font stacks, line spacing, first-line indent, text width, and four background themes
- Keyboard navigation for page turns, contents, text size, and panel dismissal
- Explicit text-only feedback submission to the developer's feedback server
- Duplicate detection, local deletion, a 250 MB per-file safety limit for EPUB/PDF, and an 8 MB limit for browser-rendered TXT/Markdown
- Installable PWA application shell
- Fully static GitHub Pages deployment

Books, extracted content, reading progress, and preferences remain in the current browser during ordinary reading. Clearing site data can remove the local library. PWA installation is not a backup. Explicit feedback sends only the text the user submits. Local development builds have an additional experimental translation path: after an in-session disclosure and confirmation, only the current TXT/Markdown paragraph or a same-paragraph selection that the user individually requests is sent through a loopback-only proxy to DeepSeek. The file, title, book ID, fingerprint, reading position, and adjacent paragraphs are not sent. GitHub Pages does not include the proxy or remote-translation controls.

## Development

Requires Node.js 24 or newer.

```bash
npm ci
npm run dev
npm run check
npm run preview
```

`npm run check` runs unit tests, lint, TypeScript, and the production build.

### Local Translation Experiment

Remote translation is available only from `npm run dev`. Start the development server with a temporary process environment variable:

```bash
DEEPSEEK_API_KEY="..." npm run dev
```

Do not put the key in a `VITE_*` variable, source file, `.env` file, browser storage, or Git. The development proxy accepts only loopback, same-origin requests, uses fixed provider/model/prompt settings, limits request size/rate/concurrency, and does not expose upstream response details. Each translation still requires the user to enable the disclosed session and click a paragraph-level command. Translations are cached locally by document revision, source range, language, model, and prompt version; deleting the source document also deletes its cached translations.

Production builds intentionally contain no DeepSeek endpoint or API-key variable name, and Pages has no translation endpoint.

## Deployment

Pushes to `main` run checks and publish `dist/` through GitHub Actions to GitHub Pages. GitHub Actions is used only for CI/CD; the application has no server process.

The production build uses relative paths so application chunks, PDF workers, the manifest, and the service worker resolve correctly beneath `/WebReader/`.

## Privacy And Security

- No accounts, analytics, telemetry, cloud storage, runtime CDN, or remote metadata lookups
- Feedback is an explicit text-only request to `feedback.070315.site`, limited to 2000 characters. The service retains necessary connection details for rate limiting and abuse prevention; do not include sensitive information
- Local development translation is a separate opt-in exception with an in-session disclosure. It sends only the paragraph or same-paragraph selection explicitly requested by the user to DeepSeek through a loopback-only proxy; ordinary reading and the Pages build send no text to a model provider
- Source books are stored in browser IndexedDB and never included in GitHub artifacts
- EPUB scripted content and external network access are blocked by Content Security Policy
- PDF files use the worker-backed Canvas rendering path. Continuous mode mounts only a bounded page window, and WebReader does not create PDF scripting managers, sandboxes, or run document JavaScript actions
- Paper mode is format-aware: reflowable EPUB is continuous within each chapter and advances at chapter boundaries; fixed-layout EPUB remains paginated
- Reader fonts use local system stacks or fonts embedded by the publisher; WebReader does not fetch remote fonts
- Extensions and MIME types are checked alongside file signatures where available

Only use books you have the right to read. WebReader does not implement or circumvent DRM.

## License

MIT. Third-party packages remain under their respective licenses.
