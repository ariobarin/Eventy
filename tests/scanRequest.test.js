import test from "node:test";
import assert from "node:assert/strict";

import { shouldCacheScanRequest } from "../src/utils/scanRequest.js";

test("scan requests cache by default", () => {
    assert.equal(shouldCacheScanRequest({ action: "scanPage" }), true);
});

test("custom scan requests can skip page cache writes", () => {
    assert.equal(
        shouldCacheScanRequest({ action: "scanPage", cacheResults: false }),
        false
    );
});
