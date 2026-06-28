# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Eventy is a Chrome extension (Manifest V3) that extracts calendar events from webpages, selected text, pasted text, and images using an LLM, then adds them to Google Calendar or downloads ICS files. It uses a hosted proxy (`eventy-proxy.eventy.workers.dev`) to route LLM requests via OpenRouter, with optional BYOK (bring your own key) mode.

## Commands

```bash
npm test                        # Run all unit tests (Node test runner)
node --test tests/preprocess.test.js  # Run a single test file
npm run verify:ui               # Browser-based UI verification (launches Chrome)
npm run verify:ui -- --headless # Headless UI verification
npm run verify:offline          # Unit tests + headless UI (no LLM calls)
npm run verify:release          # Full suite: unit + UI + live LLM integration eval
npm run package                 # Build extension zip
npm run deploy:home             # Deploy homepage worker via Wrangler
```

## Architecture

### Extension entry points

- `manifest.json` — MV3 manifest; service worker is `src/background.js`, popup is `src/ui/index.html`
- `src/background.js` — Service worker handling scan requests (page, selection, image), context menus, keyboard shortcuts, and message routing between popup and content scripts
- `src/popup.js` — Popup UI controller; manages scan lifecycle states (IDLE → SCANNING → RESULTS_LOADED / QUOTA_EXCEEDED), cache restore, skeleton animations, and custom text/image input
- `src/ui/settings.js` + `src/ui/settings.html` — Settings page (theme, calendar provider, BYOK API key, model selection)
- `src/content/eventMarkers.js` — Content script injected into pages to highlight detected events

### LLM pipeline

- `src/llm/preprocess.js` — Core preprocessing: HTML→Markdown conversion, noisy-element removal, signal-based content condensation to fit within `MODEL_INPUT_MAX_CHARS` (18k chars). Exports `buildModelInput`, `htmlToMarkdown`, `tablesToCsvSnippets`
- `src/llm/client.js` — Builds OpenRouter API requests with structured JSON output schema, handles BYOK/shared proxy modes, rate limiting, timezone post-processing. The system prompt and event schema live here
- `src/utils/scan.js` — Orchestrates preprocessing for popup vs background contexts; manages CSV snippet budget allocation

### Supporting modules

- `src/lib/calendarUrl.js` — Google Calendar URL builder
- `src/lib/icsGenerator.js` — ICS/iCalendar file generation
- `src/utils/timezone.js` — Timezone detection and event time conversion
- `src/utils/tabAccess.js` — Tab permission checks (blocked URLs like chrome://)
- `src/utils/cache.js` — Scan result caching via chrome.storage
- `src/popup/` — Popup sub-modules: constants, date/time formatting, event cards, scan polling, settings store, tab capture, toast notifications

### Infrastructure

- `workers/eventyHome.js` — Cloudflare Worker fronting the GitHub Pages homepage at `eventy.ariobarin.com`
- `config.js` — Runtime config: `PROXY_URL`, `PROXY_TOKEN`, `MOCK_MODE`, `DEBUG`

## Testing

Tests use Node's built-in test runner (`node:test`) with `node:assert/strict`. No build step; the extension ships raw ES modules. Tests that need DOM use `jsdom`. The `tests/real-pages/` directory has a corpus (`corpus.json`) for preprocessing regression testing against captured page snapshots.

## Key Constraints

- No bundler — the extension loads ES modules directly, so all `import` paths must include `.js` extensions
- Service worker context (`src/background.js`) has no DOM/DOMParser — preprocessing that needs HTML parsing must happen in the popup before sending to background
- `config.js` exports should stay empty/safe for public commits (no tokens)
- The hosted proxy is not in this repo; BYOK headers (`X-User-Api-Key`, `X-User-Model`) and shared proxy auth (`X-Eventy-Token`) are the integration points
