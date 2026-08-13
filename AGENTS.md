# AGENTS.md

## Scope And Parent Rules

This file applies to the WebReader repository. Cross-project strategy, Git/main rules, and the default desktop validation target come from `../070315-site/AGENTS.md`. Read that file before cross-project work or before changing this file.

`OWNER-MAINTAINED` sections record product policy and must not be changed without an explicit user decision. `AGENT-MAINTAINED` sections record verified project facts and must be updated with the code or workflow that changes them.

## OWNER-MAINTAINED: Product Boundary

- WebReader is a private-by-default, local-first browser reader.
- The interface is bilingual Chinese/English and defaults to Chinese; user language choice is kept in the browser.
- Imported book bytes, covers, reading history, annotations, and search indexes must not be uploaded to GitHub or any remote service. Ordinary reading never sends extracted text. Whole-paper translation is a separate explicit action: after the user selects a provider, reviews the exact destination host and estimated document size, and confirms, bounded text batches may be sent directly to that provider. The API key remains only in the current tab memory; translation tasks and validated results may be stored locally in IndexedDB.
- User-submitted feedback text may be sent to the shared feedback service only after an explicit submit action and must never include book files, names, library metadata, reading history, or fingerprints.
- Local development paragraph translation remains an additional testing path through the loopback-only DeepSeek proxy. Production whole-paper translation uses user-provided credentials and direct provider adapters; it must not send files, book names, book IDs, fingerprints, reading positions, or unrelated library metadata. Provider, model, destination host, target language, block count, and source character estimate must be disclosed before the first batch is sent.
- Text-layer PDFs may be analyzed locally into stable source blocks, shown with a selectable PDF.js text layer over the authoritative Canvas, and translated in recoverable batches after explicit provider confirmation. Equations and references remain verbatim by default; captions are translatable; original page visuals remain available beside aligned text. OCR, server-managed credentials, automatic translation without confirmation, and background execution after the page closes are not supported.
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
- `src/lib/textDocument.ts`: stable source ranges and structured TXT/Markdown blocks for local reading and development translation.
- `src/lib/paperTranslation.ts`: provider-neutral whole-paper batching, protected-token validation, OpenAI/Anthropic/DeepSeek/custom OpenAI-compatible adapters, and the isolated translation runtime bridge.
- `src/components/PdfTranslationDialog.tsx`: in-session provider, model, endpoint, key, target-language, destination disclosure, and explicit whole-paper confirmation.
- `translator.html` and `src/translator.ts`: isolated same-origin iframe execution surface with a translation-only CSP; the main reader CSP remains restricted.
- `dev/deepseekProxy.ts`: loopback-only, development-only DeepSeek proxy with fixed provider settings, request/rate/concurrency limits, cancellation, and no credential exposure.
- `src/lib/pdfText.ts`: bounded local PDF text-layer normalization, line/column ordering, semantic blocks, stable IDs, repeated-margin removal, and conservative page-quality gates.
- `src/lib/pdfOutline.ts`: local PDF outline destination resolution.
- `src/lib/pdfLayout.ts`: bounded continuous-PDF page windows, real page geometry, and stable page-relative scroll restoration.
- `src/lib/wheelPager.ts`: one-turn-per-gesture mouse-wheel pagination with boundary eligibility for scrollable pages.
- `src/lib/formats.ts`: file size, signature, extension, and MIME validation.
- `src/lib/fingerprint.ts`: bounded content fingerprinting used for local duplicate detection.
- `src/lib/storage.ts`: Dexie/IndexedDB repository for book metadata, source Blob, settings, locators, and versioned translation cache.
- `src/lib/i18n.ts`: Chinese/English interface strings and language selection.
- `src/lib/feedback.ts`: explicit text-only feedback request to the shared Cloudflare feedback service.
- `src/types/`: stable publication, locator, preference, and third-party adapter types.
- `public/`: committed application icons and public static assets.
- `dist/`: generated Vite/Pages artifact; never edit or commit.

The stack is React, TypeScript, Vite, Dexie, foliate-js, PDF.js, Lucide, Vitest, Oxlint, and vite-plugin-pwa. EPUB, PDF, and text use separate reader adapters, capabilities, outline sources, and locator types. EPUB cleanup is idempotent so async initialization and React unmount cannot release the same renderer twice; the root error boundary keeps a local recovery path if a reader still fails unexpectedly. Reflowable EPUB/text support local typography and background preferences; fixed-layout EPUB/PDF do not expose typography controls. PDF Canvas remains the authoritative visual source and now has an official PDF.js TextLayer overlay for selection. Bounded local analysis preserves text-item provenance, stable source blocks, reading order, repeated-margin removal, protected visual/verbatim content, and page-relative locators. Whole-paper translation starts only after provider configuration and destination confirmation, groups immutable display blocks into dynamic request batches, strictly validates returned IDs and protected tokens, and stores recoverable jobs, batches, and results in Dexie version 4. The paired view uses one shared grid row per source/translation block, permits blank space on the shorter side, preserves original page visuals, offers translation-only reading, and highlights the counterpart block when either side is selected. API keys, authorization headers, complete requests, and raw provider responses are never persisted. Source books and metadata are stored atomically in IndexedDB; Dexie version 2 adds a per-document `book | article` reading profile and version 3 retains the earlier explicit TXT/Markdown translation cache. Book mode supports wheel page turns using a gesture accumulator; Paper mode uses native vertical scrolling. Reflowable EPUB uses chapter-continuous Foliate scrolling, PDF uses a bounded window of Canvas pages with page-relative locators, and text remains a local scrolling document. TXT and Markdown imports are limited to 8 MB because they are decoded and rendered into browser memory and DOM. The Chinese/English UI defaults to Chinese and stores only the selected language locally. Explicit feedback submissions send text plus product/language labels to `https://feedback.070315.site/feedback`; no library context is attached. In local development only, TXT/Markdown Paper mode can create a shared-row bilingual view. After an in-session disclosure, each user command sends only the current paragraph or same-paragraph selection through the loopback development proxy to DeepSeek. Dexie version 3 caches validated translation results by full document revision, source range, target language, model, and prompt version; deleting a book cascades to its translations. The Pages build has no proxy or remote-translation controls, and production artifacts must not contain the provider URL or key environment-variable name.

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
- Translation job, batch, and result records never contain API keys, authorization headers, complete requests, raw provider responses, or source file metadata. A saved job resumes only after the user re-enters a key in the current tab.
- A translation cache write must verify its parent book still exists in the same transaction; deleting a book removes cached translations in the same transaction.
- Local development remote translation requires an in-session disclosure and explicit per-unit commands. Only loopback, same-origin proxy requests are accepted; ordinary reading and GitHub Pages never send text to a model provider.
- Translation selection must remain within one structured source block. Never silently expand a selection to adjacent blocks or include document/library metadata.
- `BookRecord.id` is a random local identifier. The fingerprint is used only inside this browser for duplicate detection; never expose cross-user deduplication signals.
- Deleting a book removes both metadata and source Blob. It never modifies the original file selected from the user's filesystem.
- A locator is format-specific: EPUB CFI, PDF page index, or text progression. Do not replace it with a generic rendered page number.
- IndexedDB schema changes require an ordered Dexie migration and tests for reading existing data. Never silently clear a user's library to resolve a migration error.
- PWA installation and persistent-storage permission are not backups. Storage UI must describe browser-clearing risk accurately.
- Object URLs, PDF documents, render tasks, ebook renderers, workers, and large buffers must be released when replaced or unmounted.

## File And Rendering Safety

- Do not trust extension or client MIME alone. Keep signature/container checks and explicit file/resource limits.
- EPUB and other archive formats are untrusted active inputs. Keep the restrictive CSP, block scripted publication content, forms, remote resource requests, and automatic external navigation.
- PDF.js must run parsing in its worker. Keep Canvas as the authoritative rendering source and do not create or import PDF scripting managers, sandboxes, or document JavaScript actions. The official PDF.js TextLayer may overlay Canvas solely for local selection and source-item mapping. Bounded analysis and provider-confirmed translation may use `getTextContent()`; ordinary reading must not transmit it.
- Do not add remote fonts, runtime CDNs, metadata APIs, cover fetches, link prefetching, or any ordinary-reader network destination beyond the reviewed feedback endpoint and loopback-only development proxy. The isolated translation runtime may connect only to the HTTPS provider endpoint whose host the user confirms for that whole-paper task; redirects are rejected. It uses a separate entry, bundle, CSP, and private transferred MessagePort, but remains same-origin so static Pages can load its module. This limits ordinary-reader capabilities but is not an XSS, extension, or developer-tools security boundary; the UI must recommend a revocable temporary key.
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
