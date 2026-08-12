# WebReader

A private-by-default web reader for local books. Import DRM-free EPUB, PDF, TXT, or Markdown files and read them without uploading book content to a server.

Production: https://FIERsity.github.io/WebReader/

## Current Features

- Local library persisted in IndexedDB
- EPUB reading with paginated navigation and CFI progress
- PDF rendering with PDF.js and page progress
- TXT and Markdown reading with UTF-8/GB18030 fallback
- Theme and text-size preferences
- Duplicate detection, local deletion, and a 250 MB per-file safety limit
- Installable PWA application shell
- Fully static GitHub Pages deployment

Books, extracted content, reading progress, and preferences remain in the current browser. Clearing site data can remove the local library. PWA installation is not a backup.

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
- Source books are stored in browser IndexedDB and never included in GitHub artifacts
- EPUB scripted content and external network access are blocked by Content Security Policy
- PDF JavaScript evaluation is disabled
- Extensions and MIME types are checked alongside file signatures where available

Only use books you have the right to read. WebReader does not implement or circumvent DRM.

## License

MIT. Third-party packages remain under their respective licenses.
