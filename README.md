# WebReader

A private-by-default bilingual web reader for local books. The interface supports 中文 and English and defaults to Chinese. Import DRM-free EPUB, PDF, TXT, or Markdown files and read them without uploading book content to a server.

Production: https://FIERsity.github.io/WebReader/

## Current Features

- Local library persisted in IndexedDB
- EPUB reading with paginated navigation, nested table of contents, and CFI progress
- PDF rendering with PDF.js, document outlines, and page progress
- TXT and Markdown-as-text reading with UTF-8/GB18030 fallback and local heading outlines
- Chinese/English interface with a locally remembered language choice
- Reading controls for text size, local font stacks, line spacing, first-line indent, text width, and four background themes
- Keyboard navigation for page turns, contents, text size, and panel dismissal
- Explicit text-only feedback submission to the developer's feedback server
- Duplicate detection, local deletion, and a 250 MB per-file safety limit
- Installable PWA application shell
- Fully static GitHub Pages deployment

Books, extracted content, reading progress, and preferences remain in the current browser. Clearing site data can remove the local library. PWA installation is not a backup. The only runtime network exception is feedback text that the user explicitly submits; WebReader does not attach book names, files, library metadata, fingerprints, or reading history.

## Development

Requires Node.js 24 or newer.

```bash
npm ci
npm run dev
npm run check
npm run preview
```

`npm run check` runs unit tests, lint, TypeScript, and the production build.

## Deployment

Pushes to `main` run checks and publish `dist/` through GitHub Actions to GitHub Pages. GitHub Actions is used only for CI/CD; the application has no server process.

The production build uses relative paths so application chunks, PDF workers, the manifest, and the service worker resolve correctly beneath `/WebReader/`.

## Privacy And Security

- No accounts, analytics, telemetry, cloud storage, runtime CDN, or remote metadata lookups
- Feedback is an explicit text-only request to `feedback.070315.site`, limited to 2000 characters. The service retains necessary connection details for rate limiting and abuse prevention; do not include sensitive information
- Source books are stored in browser IndexedDB and never included in GitHub artifacts
- EPUB scripted content and external network access are blocked by Content Security Policy
- PDF files use the worker-backed Canvas rendering path. WebReader does not create PDF scripting managers, sandboxes, or run document JavaScript actions
- Reader fonts use local system stacks or fonts embedded by the publisher; WebReader does not fetch remote fonts
- Extensions and MIME types are checked alongside file signatures where available

Only use books you have the right to read. WebReader does not implement or circumvent DRM.

## License

MIT. Third-party packages remain under their respective licenses.
