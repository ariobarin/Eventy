# Real-Page Corpus

`corpus.json` lists reusable public pages and the event labels expected to be
retained by Eventy's scan-context preprocessing.

Captured page snapshots are local generated artifacts under
`tests/fixtures/real-pages/`. They are intentionally ignored because they are
large and can contain page chrome, scripts, and other third-party markup.

Run the full local verification loop with:

```bash
npm run verify:real-pages
```

That command recaptures the corpus with Chrome, then audits the fresh snapshots.
For faster iteration on an existing local snapshot cache, run:

```bash
npm run audit:real-pages
```

LLM judged comparisons are optional because they require an eval transport:

```bash
npm run compare:real-pages:llm
```
