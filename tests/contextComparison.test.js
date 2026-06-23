import test from "node:test";
import assert from "node:assert/strict";

import {
    buildStaticComparisonPage,
    buildStaticVariantResult,
    buildErroredVariantResult,
    contextStats,
    formatComparisonLine,
    isRetryableVariantError,
    summarizeComparisonPages,
} from "../scripts/compare-real-pages-old-new.mjs";

test("context comparison stats count model and csv input", () => {
    assert.deepEqual(
        contextStats({
            modelHtml: "abcd",
            csvSnippets: ["123", "xy"],
        }),
        {
            modelInputChars: 4,
            csvSnippetCount: 2,
            csvChars: 5,
            separatorChars: 2,
            contextChars: 11,
        }
    );
});

test("old-new comparison retries transient LLM response errors only", () => {
    assert.equal(
        isRetryableVariantError(new Error("Unexpected end of JSON input")),
        true
    );
    assert.equal(isRetryableVariantError(new Error("The user is missing")), false);
});

test("old-new comparison summary reports savings and regressions", () => {
    const summary = summarizeComparisonPages([
        {
            name: "kept-quality",
            old: { passed: true, misses: 0, contextChars: 1000 },
            current: { passed: true, misses: 0, contextChars: 400 },
        },
        {
            name: "regressed-quality",
            old: { passed: true, misses: 0, contextChars: 800 },
            current: { passed: false, misses: 1, contextChars: 300 },
        },
    ]);

    assert.equal(summary.pageCount, 2);
    assert.equal(summary.oldPasses, 2);
    assert.equal(summary.currentPasses, 1);
    assert.deepEqual(summary.regressions, ["regressed-quality"]);
    assert.deepEqual(summary.oldErrors, []);
    assert.deepEqual(summary.currentErrors, []);
    assert.equal(summary.totalOldContextChars, 1800);
    assert.equal(summary.totalNewContextChars, 700);
    assert.equal(summary.savedContextChars, 1100);
    assert.equal(summary.currentVsOldContextRatio, 0.3889);
    assert.equal(summary.savingsRatio, 0.6111);
    assert.equal(summary.passed, false);
});

test("old-new comparison summary reports baseline errors without blocking current pass", () => {
    const summary = summarizeComparisonPages([
        {
            name: "old-timeout",
            old: {
                passed: false,
                misses: 2,
                contextChars: 1000,
                error: "timed out",
            },
            current: { passed: true, misses: 0, contextChars: 500 },
        },
    ]);

    assert.equal(summary.passed, true);
    assert.deepEqual(summary.oldErrors, ["old-timeout"]);
    assert.deepEqual(summary.currentErrors, []);
    assert.deepEqual(summary.regressions, []);
    assert.deepEqual(summary.improvements, []);
});

test("old-new comparison summary fails when current errors", () => {
    const summary = summarizeComparisonPages([
        {
            name: "current-timeout",
            old: { passed: true, misses: 0, contextChars: 800 },
            current: {
                passed: false,
                misses: 2,
                contextChars: 400,
                error: "timed out",
            },
        },
    ]);

    assert.equal(summary.passed, false);
    assert.deepEqual(summary.oldErrors, []);
    assert.deepEqual(summary.currentErrors, ["current-timeout"]);
    assert.deepEqual(summary.regressions, []);
    assert.deepEqual(summary.improvements, []);
});

test("old-new comparison line includes quality and size deltas", () => {
    const line = formatComparisonLine({
        name: "sample",
        old: { passed: true, misses: 0, contextChars: 1000 },
        current: { passed: true, misses: 0, contextChars: 250 },
        savedContextChars: 750,
    });

    assert.match(line, /^PASS sample /);
    assert.match(line, /oldMisses=0/);
    assert.match(line, /currentMisses=0/);
    assert.match(line, /saved=750/);
});

test("old-new comparison line marks request errors explicitly", () => {
    const line = formatComparisonLine({
        name: "timeout-page",
        old: { passed: true, misses: 0, contextChars: 1000 },
        current: {
            passed: false,
            misses: 1,
            contextChars: 250,
            error: "timed out",
        },
        savedContextChars: 750,
    });

    assert.match(line, /^ERROR timeout-page /);
    assert.match(line, /currentError=timed out/);
});

test("old-new comparison line warns on baseline-only errors", () => {
    const line = formatComparisonLine({
        name: "timeout-page",
        old: {
            passed: false,
            misses: 1,
            contextChars: 1000,
            error: "timed out",
        },
        current: { passed: true, misses: 0, contextChars: 250 },
        savedContextChars: 750,
    });

    assert.match(line, /^WARN timeout-page /);
    assert.match(line, /oldError=timed out/);
});

test("static variant result evaluates event labels across model and csv context", () => {
    const result = buildStaticVariantResult({
        fixture: {
            expectedEvents: [
                {
                    title: "Opening Keynote",
                    date: "June 24, 2026",
                },
                {
                    title: "Workshop Lab",
                    date: "June 25, 2026",
                },
            ],
        },
        preprocessed: {
            modelHtml: "Opening Keynote\nJune 24, 2026",
            csvSnippets: ['"Title","Date"\n"Workshop Lab","June 25, 2026"'],
        },
    });

    assert.equal(result.passed, true);
    assert.equal(result.matches, 2);
    assert.equal(result.misses, 0);
    assert.equal(result.contextChars, 75);
});

test("static variant result reports missing retained labels", () => {
    const result = buildStaticVariantResult({
        fixture: {
            expectedEvents: [
                {
                    title: "Missing Details Talk",
                    date: "June 26, 2026",
                    location: "Room 101",
                },
            ],
        },
        preprocessed: {
            modelHtml: "Missing Details Talk\nJune 26, 2026",
            csvSnippets: [],
        },
    });

    assert.equal(result.passed, false);
    assert.equal(result.matches, 0);
    assert.equal(result.misses, 1);
    assert.deepEqual(result.missingEventLabels, [
        "Missing Details Talk: location=Room 101",
    ]);
});

test("static comparison page reports retention changes and savings", () => {
    const page = buildStaticComparisonPage({
        fixture: {
            name: "sample-page",
            url: "https://example.test/events",
            expectedEvents: [
                {
                    title: "Workshop Lab",
                    date: "June 25, 2026",
                },
            ],
        },
        oldPreprocessed: {
            modelHtml: "Workshop Lab",
            csvSnippets: [],
        },
        currentPreprocessed: {
            modelHtml: "Workshop Lab\nJune 25, 2026",
            csvSnippets: [],
        },
    });

    assert.equal(page.name, "sample-page");
    assert.equal(page.expectedEventCount, 1);
    assert.equal(page.old.passed, false);
    assert.equal(page.current.passed, true);
    assert.equal(page.old.misses, 1);
    assert.equal(page.current.misses, 0);
    assert.equal(page.savedContextChars, -14);
    assert.equal(page.currentVsOldContextRatio, 2.1667);
});

test("old-new comparison records variant errors without losing size stats", () => {
    const result = buildErroredVariantResult({
        stats: {
            modelInputChars: 10,
            csvSnippetCount: 1,
            csvChars: 4,
            contextChars: 14,
        },
        expectedEventCount: 3,
        error: new Error("timed out"),
    });

    assert.equal(result.passed, false);
    assert.equal(result.matches, 0);
    assert.equal(result.misses, 3);
    assert.equal(result.contextChars, 14);
    assert.equal(result.error, "timed out");
});
