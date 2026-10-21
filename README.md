# Eventy

Chrome extension that turns event pages, selected text, pasted text, and flyer images into calendar events.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/eventy/kfancgcbhdkeohknmidbnioccmmoknjl) · [Homepage](https://eventy.ariobarin.com/)

## Use it

| To scan | Do this |
| --- | --- |
| The whole page | Click the Eventy icon, then **Scan Page** |
| Some text | Select it, then right-click **Scan selected text for events** or press `Ctrl+Shift+E` (`Cmd+Shift+E` on Mac) |
| An image or flyer | Right-click it, then **Scan image for events** |
| Text or photos you have | Click the upload icon in the popup, paste text or add images, then **Scan Media** |

Pick the events you want and click **Add to Calendar**. Eventy opens a prefilled Google Calendar tab per event, or downloads `.ics` files (open them to import into Apple Calendar, Outlook, and others). Choose which in Settings.

Scans use a shared free daily limit. For unlimited scans, add your own [OpenRouter](https://openrouter.ai/) key in Settings and pick any model that supports structured outputs.

## How it works

1. The popup reads the page, converts it to compact Markdown, and pulls tables out as CSV.
2. The background worker sends that context to the Eventy proxy, which calls an LLM through OpenRouter with a strict JSON schema.
3. Eventy dedupes the events, converts explicit timezones to yours, and builds Google Calendar links or `.ics` files locally.

The proxy (`eventy-proxy.eventy.workers.dev`) is a separate Cloudflare Worker and is not in this repo. See [PRIVACY.md](PRIVACY.md) for what it receives.

## Develop

```bash
npm install
npm test
```

Load the repo folder at `chrome://extensions` with Developer mode on (Load unpacked), and reload it after changes. There is no build step; the extension runs plain ES modules.

Set `MOCK_MODE = true` in [config.js](config.js) to get sample events without calling the proxy, and `DEBUG = true` for verbose logs. Keep both `false` and `PROXY_TOKEN` empty in commits.

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (Node test runner) |
| `npm run verify:ui -- --headless` | Loads the extension in Chrome (mock mode) and drives the popup and settings |
| `npm run audit:real-pages` | Checks that real-page snapshots keep their event details after preprocessing (`capture:real-pages` first) |
| `npm run verify:release` | All of the above plus a live LLM eval through the proxy |
| `npm run package` | Builds `dist/eventy-v<version>.zip` for the Web Store |
| `npm run deploy:home` | Deploys the homepage Worker ([workers/eventyHome.js](workers/eventyHome.js)) |

UI tests need Chrome installed; set `CHROME_PATH` if it isn't found. See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

## Legal

[Privacy Policy](https://eventy.ariobarin.com/privacy.html) · [Terms of Service](https://eventy.ariobarin.com/terms.html) · MIT License
