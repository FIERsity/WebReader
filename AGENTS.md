# AGENTS.md

## Scope And Parent Rules

This file applies to the WebReader repository. Cross-project strategy, Git/main rules, and the default desktop validation target come from `../070315-site/AGENTS.md`. Read that file before cross-project work or before changing this file.

`OWNER-MAINTAINED` sections record product policy and must not be changed without an explicit user decision. `AGENT-MAINTAINED` sections record verified project facts and must be updated with the code or workflow that changes them.

## OWNER-MAINTAINED: Product Boundary

- WebReader is a private-by-default, local-first browser reader.
- The interface is bilingual Chinese/English and defaults to Chinese; user language choice is kept in the browser.
- Imported book bytes, covers, reading history, annotations, search indexes, and locally reflowed paper text must not be uploaded to GitHub or any remote service. Ordinary reading and paper reflow never send extracted text. WebReader currently has no content-translation UI, provider runtime, development proxy, or standalone translation entry; existing local translation records may remain only for IndexedDB compatibility and must not be read or resumed by the application.
- User-submitted feedback text may be sent to the shared feedback service only after an explicit submit action and must never include book files, names, library metadata, reading history, or fingerprints.
- Text-layer PDFs may be analyzed locally into stable source blocks, shown as a deterministic single-column article or a page-by-page proof view beside the authoritative PDF Canvas, and mapped back to PDF.js TextLayer items and source regions. OCR, semantic rewriting, model-assisted ordering, and silent synthesis of missing content are not supported.
- GitHub Pages hosts only the static application. GitHub Actions is CI/CD, not an application server or persistent VPS.
- The first supported formats are DRM-free EPUB, PDF, TXT, and Markdown-as-text. DRM circumvention is out of scope.
- Accounts, cloud storage, telemetry, analytics, public sharing, OCR, server-side conversion, and third-party book metadata requests are not added without explicit approval as a major change.
- Default development and acceptance target is desktop landscape around 1440x900. Existing responsive and touch behavior must remain basically usable.
- Small, bounded fixes can go directly to `main` after minimum validation. Major workflow, storage protocol, security boundary, format, framework, or deployment changes require a scope/risk proposal and user confirmation first.

## Workflow

1. Run `git status --short --branch` and preserve existing local changes and untracked material.
2. Use Node 24 or newer, npm, and the committed `package-lock.json`.
3. Never add real books, private documents, screenshots, browser profiles, IndexedDB dumps, generated build output, or test output to Git.
4. Use synthetic fixtures or clearly redistributable public-domain fixtures only. Record provenance for any non-synthetic fixture.
5. Stage explicit paths. Inspect `git diff --cached` and the staged file list before every commit.
6. A push to `main` publishes production through GitHub Pages. Run the minimum validation before pushing.

## AGENT-MAINTAINED: Project Facts

<!-- AGENT-MAINTAINED:START project-facts -->

### Architecture

- `src/App.tsx`: library and reader-shell coordination, import/delete flows, reader panels, preferences, shortcuts, and format dispatch.
- `src/components/`: reading settings, recursive outline panels, and the root interface recovery boundary.
- `src/readers/`: isolated EPUB, PDF, and text rendering adapters.
- `src/lib/preferences.ts`: validated migration from legacy reader preferences to the versioned preference model.
- `src/lib/epubStyles.ts`: paired EPUB theme colors for body text, text surfaces, and code surfaces without recoloring publication media or removing CSS background images.
- `src/lib/textDocument.ts`: stable source ranges and structured TXT/Markdown blocks for local reading and outline navigation.
- `src/lib/textPagination.ts`: viewport-sized TXT/Markdown page geometry, source-range lookup, and horizontal page calculations that preserve character-offset locators across reflow.
- `src/lib/pdfText.ts`: bounded local PDF text-layer normalization, line/column ordering, semantic blocks, stable IDs, repeated-margin removal, conservative page-quality gates, and source geometry provenance.
- `src/readers/PdfReader.tsx`: authoritative PDF rendering plus the local reflowed-article and page-by-page proof views.
- `src/lib/pdfOutline.ts`: local PDF outline destination resolution.
- `src/lib/pdfLayout.ts`: bounded continuous-PDF page windows, real page geometry, and stable page-relative scroll restoration.
- `src/lib/wheelPager.ts`: one-turn-per-gesture mouse-wheel pagination with boundary eligibility for scrollable pages.
- `src/lib/formats.ts`: file size, signature, extension, and MIME validation.
- `src/lib/fingerprint.ts`: bounded content fingerprinting used for local duplicate detection.
- `src/lib/storage.ts`: Dexie/IndexedDB repository for book metadata, source Blob, settings, locators, and legacy translation-store declarations retained only to open and clean up existing v3/v4 databases without losing books.
- `src/lib/i18n.ts`: Chinese/English interface strings and language selection.
- `src/lib/feedback.ts`: explicit text-only feedback request to the shared Cloudflare feedback service.
- `src/types/`: stable publication, locator, preference, and third-party adapter types.
- `public/`: committed application icons and public static assets.
- `dist/`: generated Vite/Pages artifact; never edit or commit.

The stack is React, TypeScript, Vite, Dexie, foliate-js, PDF.js, Lucide, Vitest, Oxlint, and vite-plugin-pwa. EPUB, PDF, and text use separate reader adapters, capabilities, outline sources, and locator types. EPUB cleanup is idempotent so async initialization and React unmount cannot release the same renderer twice; the root error boundary keeps a local recovery path if a reader still fails unexpectedly. Reflowable EPUB/text support local typography and background preferences; fixed-layout EPUB/PDF do not expose typography controls. TXT and Markdown paged mode lays text into viewport-sized horizontal CSS columns, while scroll mode keeps a continuous vertical document; both modes persist source character offsets so typography and viewport reflow do not invalidate progress. The active document's paged/scroll mode is changed from the reader toolbar and remembered per document; fixed-layout EPUB disables that control. PDF Canvas remains the authoritative visual source and has an official PDF.js TextLayer overlay for selection. Bounded local analysis preserves text-item provenance, stable source blocks, deterministic reading order, repeated-margin removal, page-quality diagnostics, and page-relative locators. The PDF tool exposes a continuous single-column article view and a page-by-page proof view beside original page previews. Content-translation code, provider configuration, remote execution, development proxying, and production translation entries are absent; only the existing Dexie v3/v4 store names remain for non-destructive database compatibility and cascading cleanup when a book is deleted.

### Commands

- Install: `npm ci`
- Develop: `npm run dev`
- Unit tests: `npm test`
- Watch tests: `npm run test:watch`
- Lint: `npm run lint`
- Type-check and build: `npm run build`
- Full minimum validation: `npm run check`
- Preview production build: `npm run preview`

File import, IndexedDB migration, PWA, EPUB/PDF rendering, worker URL, CSP, page navigation, or visual changes also require a desktop browser check through an HTTP server.

### Deployment

`main` is built and published by GitHub Actions to GitHub Pages. The public URL is `https://FIERsity.github.io/WebReader/`. Vite uses relative asset paths so workers, manifest, icons, and application chunks resolve beneath the Pages repository path.

The service worker caches only the application shell. User book data belongs in IndexedDB and must never be copied into Cache Storage, a Pages artifact, Actions artifact, log, or repository file.

<!-- AGENT-MAINTAINED:END project-facts -->

## Storage And Privacy Invariants

- An imported source Blob and its `BookRecord` are written in one IndexedDB transaction.
- Legacy translation stores from IndexedDB versions 3 and 4 remain declared only so existing libraries open without a destructive migration. Application code must not expose APIs that create, read, or resume those records; deleting a parent book still removes its legacy records in the same transaction.
- `BookRecord.id` is a random local identifier. The fingerprint is used only inside this browser for duplicate detection; never expose cross-user deduplication signals.
- Deleting a book removes both metadata and source Blob. It never modifies the original file selected from the user's filesystem.
- A locator is format-specific: EPUB CFI, PDF page index, or text progression. Do not replace it with a generic rendered page number.
- IndexedDB schema changes require an ordered Dexie migration and tests for reading existing data. Never silently clear a user's library to resolve a migration error.
- PWA installation and persistent-storage permission are not backups. Storage UI must describe browser-clearing risk accurately.
- Object URLs, PDF documents, render tasks, ebook renderers, workers, and large buffers must be released when replaced or unmounted.

## File And Rendering Safety

- Do not trust extension or client MIME alone. Keep signature/container checks and explicit file/resource limits.
- EPUB and other archive formats are untrusted active inputs. Keep the restrictive CSP, block scripted publication content, forms, remote resource requests, and automatic external navigation.
- PDF.js must run parsing in its worker. Keep Canvas as the authoritative rendering source and do not create or import PDF scripting managers, sandboxes, or document JavaScript actions. The official PDF.js TextLayer may overlay Canvas solely for local selection and source-item mapping. Bounded local reflow may use `getTextContent()` but must not transmit it, infer missing text, or hide rejected pages.
- Do not add remote fonts, runtime CDNs, metadata APIs, cover fetches, link prefetching, content-translation providers, or any ordinary-reader network destination beyond the reviewed feedback endpoint without a new explicit product decision.
- Feedback requests must remain text-only, explicit, bounded to 2000 characters, and covered by client tests. Never attach book or library context. The shared service may retain connection metadata only for rate limiting, abuse prevention, and the protected feedback viewer.
- A new format needs its own input validation, adapter, locator semantics, compatibility statement, malformed fixtures, and resource limits.
- "Supported" means the project defines readable output, navigation, progress stability, failure behavior, and cleanup. Opening one sample is not sufficient.

## GitHub And Pages Safety

- Workflows use least privilege. Checks need `contents: read`; Pages deploy needs only `contents: read`, `pages: write`, and `id-token: write`.
- Pull-request jobs must never gain deployment secrets or write permissions. Do not execute untrusted PR code in a privileged deployment job.
- GitHub-hosted runners and Codespaces are not production servers. Do not add keepalive loops, tunnels, scheduled server restarts, or similar workarounds.
- Keep all URLs, workers, dynamic imports, manifest paths, service-worker scope, and navigation compatible with the `/WebReader/` Pages subpath.
- Service-worker updates must not discard unsaved reading state or mix an incompatible application bundle with a new IndexedDB schema.

## Documentation Maintenance

Agents may update verified `AGENT-MAINTAINED` facts. Changes to repository name/path, public URL, minimum validation, runtime, deployment, privacy boundary, or supported formats must also update `../070315-site/AGENTS.md`. Public features, formats, data behavior, installation, or deployment changes also update README. Do not record temporary progress, commit hashes, deployment IDs, secrets, or private sample details in AGENTS files.
