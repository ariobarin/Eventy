# Eventy

Eventy is a Chrome extension that finds event details on webpages, images, and pasted text, then turns them into calendar-ready entries.

Version: v1.1.1

Homepage: https://eventy.ariobarin.com/

## What It Does

- Scans active pages, selected text, pasted text, images, flyers, and schedules.
- Extracts titles, dates, times, locations, descriptions, previews, and recurrence hints.
- Adds selected events to Google Calendar or downloads iCalendar files.
- Separates upcoming and past events before you add anything.
- Supports light, dark, and system themes.
- Lets advanced users bring their own OpenRouter API key and choose a model.
- Shows shared free scan usage in settings from the hosted proxy.

## Install For Development

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select this repository folder.

Reload the extension from `chrome://extensions/` after code changes.

## Configuration

Runtime knobs live in [config.js](config.js):

- `PROXY_URL`: hosted Eventy extraction proxy.
- `PROXY_TOKEN`: optional shared proxy token.
- `MOCK_MODE`: loads sample events instead of calling the proxy.

The hosted proxy is not part of this repository. It is operated separately. BYOK users can provide their own OpenRouter key in settings, with key validation and model listing routed through the proxy.

## Project Structure

```text
assets/          Extension icons
src/background/  Calendar opening helpers
src/content/     Page marker script
src/lib/         Calendar URL and ICS helpers
src/llm/         Client and preprocessing pipeline
src/mocks/       Mock scan data
src/ui/          Popup, settings, and styles
src/utils/       Storage, scan, string, timezone, and logging helpers
tests/           Node tests
webstore-docs/   Chrome Web Store submission notes
```

## Tests

```bash
npm test
```

Real-page verification uses local static snapshots so the test corpus can be
audited without committing large captured pages.

```bash
npm run capture:real-pages
npm run audit:real-pages
```

Use `npm run verify:real-pages` to recapture every corpus page and audit the
fresh snapshots in one command. Compare retained labels and context size against
the v1.1.1-era preprocessing baseline with `npm run compare:real-pages:static`.
LLM judging is available through `npm run compare:real-pages:llm` when an eval
transport is configured.

## Homepage Front

The public product page is served from this repository's GitHub Pages output and fronted at `https://eventy.ariobarin.com/` by the Cloudflare Worker in [workers/eventyHome.js](workers/eventyHome.js). The previous `https://ariobarin.com/eventy-home/` URL remains supported.

```bash
npm run deploy:home
```

## Legal

- [Privacy Policy](https://ariobarin.github.io/Eventy/privacy.html)
- [Terms of Service](https://ariobarin.github.io/Eventy/terms.html)

## License

MIT
