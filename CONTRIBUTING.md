# Contributing to Eventy

Small, focused pull requests against `main` are easiest to review. Check open issues and PRs first.

## Setup

See [Develop](README.md#develop) in the README. Run `npm test` before opening a PR, and for popup or settings changes, also load the unpacked extension and try a real scan (page, selection, pasted text, or image). Include a screenshot for visible UI changes.

## Preprocessing changes

Changes to `src/llm/preprocess.js` or `src/utils/scan.js` should be checked against the real-page corpus instead of live sites:

```bash
npm run capture:real-pages   # renders tests/real-pages/corpus.json into ignored local snapshots
npm run audit:real-pages     # checks each snapshot keeps its expected event labels
```

Keep the audit generic: corpus labels are ground truth, not per-page exceptions. If a live page changes, refresh its snapshot and update its labels rather than weakening them.

## Handle with care

- Calendar URLs and `.ics` output: dates, times, timezones, all-day events, and recurrence.
- Privacy: never log page content, API keys, or raw scan payloads, and never commit secrets or a non-empty `PROXY_TOKEN`.
- Manifest permissions: keep them minimal and update `webstore-docs/` justifications when they change.

## Security

Report vulnerabilities privately to eventy.sup@gmail.com rather than in a public issue.
