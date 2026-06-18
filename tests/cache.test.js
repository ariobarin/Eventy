import test from "node:test";
import assert from "node:assert/strict";

import { isFreshScanResult } from "../src/utils/cache.js";

test("fresh scan result requires cache written after scan start", () => {
    assert.equal(
        isFreshScanResult({ events: [{}], ts: 2000 }, 1000),
        true
    );
    assert.equal(
        isFreshScanResult({ events: [{}], ts: 999 }, 1000),
        false
    );
});

test("fresh scan result rejects malformed cache", () => {
    assert.equal(isFreshScanResult(null, 1000), false);
    assert.equal(isFreshScanResult({ events: [{}] }, 1000), false);
    assert.equal(isFreshScanResult({ events: {}, ts: 2000 }, 1000), false);
});
