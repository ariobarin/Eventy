import test from "node:test";
import assert from "node:assert/strict";

import * as config from "../config.js";
import manifest from "../manifest.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

test("manifest and package versions stay in sync", () => {
    assert.equal(manifest.version, packageJson.version);
});

test("extension only declares the Eventy proxy host", () => {
    assert.deepEqual(manifest.host_permissions, [
        "https://eventy-proxy.eventy.workers.dev/*",
    ]);
});

test("public config ships no secrets or dev toggles", () => {
    assert.equal(config.PROXY_TOKEN, "");
    assert.equal(config.MOCK_MODE, false);
    assert.equal(config.DEBUG, false);
});
