# Contributing to Eventy

Thanks for helping improve Eventy. This project is a Chrome extension that extracts event details from webpages, selected text, pasted text, and images, then turns them into calendar-ready entries.

## Before You Start

- Check existing issues and pull requests before opening a new one.
- Keep changes focused. A small pull request is easier to review and test.
- Do not commit secrets, API keys, tokens, private event data, or local browser profile files.
- Treat extraction, proxy, and calendar behavior as privacy-sensitive areas. Avoid logging full page content, user API keys, or raw scan payloads.

## Development Setup

Install dependencies:

```bash
npm install
```

Load the extension locally:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the repository folder.
5. Reload the extension from `chrome://extensions/` after code changes.

Runtime configuration lives in `config.js`.

- `MOCK_MODE` can be enabled for UI work without live extraction calls.
- `PROXY_URL` points to the hosted Eventy extraction proxy.
- `PROXY_TOKEN` should stay empty in public commits unless a maintainer says otherwise.

## Testing

Run the test suite before opening a pull request:

```bash
npm test
```

Build the extension package when a change affects release packaging or shipped files:

```bash
npm run package
```

For popup, settings, or extension behavior changes, also test manually in Chrome by loading the unpacked extension and scanning a representative page, selected text, pasted text, or image.

For LLM preprocessing changes, use local real-page fixtures instead of repeatedly scanning live sites:

```bash
npm run capture:real-pages
npm run audit:real-pages
```

The capture command renders URLs from `tests/real-pages/corpus.json` and writes ignored snapshots under `tests/fixtures/real-pages/`. The audit command replays those local snapshots through Eventy's preprocessing internals and checks that expected event anchors survive. Entries can also define `expectedEvents` with source-visible `title`, `date`, `time`, and `location` labels when those labels are visible in the captured page text. The V1 audit checks those labels page-wide in the source snapshot and retained model context, but it does not prove the labels were grouped into one extracted event. The audit uses current corpus expectations even when ignored snapshots contain older metadata, and it reports both source-label validity and retained-context validity. Keep harness rules generic and page-agnostic: use page-specific corpus labels only as ground truth, not as pass/fail exceptions in the audit logic. Do not weaken ground truth just because preprocessing drops a real visible label. If a live page changes, refresh that page's snapshot and update its anchors or event labels in the corpus instead of committing the captured DOM.

## Pull Requests

- Open pull requests against `main`.
- Describe the user-facing impact and the validation you ran.
- Include screenshots or short recordings for visible UI changes.
- Keep generated packages out of pull requests unless the change is specifically about release packaging.
- Prefer clear, direct commit messages that describe the change.

## Areas To Handle Carefully

- Calendar URL and ICS generation should preserve event dates, times, time zones, locations, and all-day behavior.
- LLM extraction changes should keep output deterministic and avoid increasing user data exposure.
- Storage changes should preserve scan cache behavior and settings persistence.
- Manifest permission changes should be minimal and justified.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities or sensitive privacy concerns. Report them privately to a maintainer first so they can assess impact and coordinate a fix.
