import test from "node:test";
import assert from "node:assert/strict";

import {
    buildErroredVariantResult,
    contextStats,
    formatComparisonLine,
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
            contextChars: 9,
        }
    );
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
    assert.equal(summary.totalOldContextChars, 1800);
    assert.equal(summary.totalNewContextChars, 700);
    assert.equal(summary.savedContextChars, 1100);
    assert.equal(summary.currentVsOldContextRatio, 0.3889);
    assert.equal(summary.savingsRatio, 0.6111);
    assert.equal(summary.passed, false);
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
