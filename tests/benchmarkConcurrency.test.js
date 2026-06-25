import test from "node:test";
import assert from "node:assert/strict";

import {
    normalizeConcurrency,
    runWithConcurrency,
} from "../scripts/benchmark-concurrency.mjs";

test("benchmark concurrency defaults to one worker", () => {
    assert.equal(normalizeConcurrency(undefined), 1);
    assert.equal(normalizeConcurrency(""), 1);
    assert.equal(normalizeConcurrency("not-a-number"), 1);
    assert.equal(normalizeConcurrency(0), 1);
});

test("benchmark concurrency accepts positive integer workers", () => {
    assert.equal(normalizeConcurrency("4"), 4);
    assert.equal(normalizeConcurrency(6), 6);
    assert.equal(normalizeConcurrency(2.8), 2);
});

test("benchmark concurrency caps runaway worker counts", () => {
    assert.equal(normalizeConcurrency(999), 16);
});

test("runWithConcurrency preserves result order and respects the limit", async () => {
    let active = 0;
    let maxActive = 0;
    const started = [];
    const items = [30, 10, 20, 5, 15];

    const results = await runWithConcurrency(items, 2, async (delayMs, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(index);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        active -= 1;
        return `result-${index}`;
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(results, [
        "result-0",
        "result-1",
        "result-2",
        "result-3",
        "result-4",
    ]);
    assert.deepEqual(started.slice(0, 2), [0, 1]);
});
