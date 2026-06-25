import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import * as config from "../config.js";
import manifest from "../manifest.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

const readmeText = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("public config does not ship shared quota policy", () => {
    assert.equal(Object.hasOwn(config, "SHARED_LIMITS"), false);
});

test("extension only declares the Eventy proxy host", () => {
    assert.deepEqual(manifest.host_permissions, [
        "https://eventy-proxy.eventy.workers.dev/*",
    ]);
});

test("package metadata is ready for public release work", () => {
    assert.equal(Object.hasOwn(packageJson, "private"), false);
    assert.equal(packageJson.version, "1.2.0");
    assert.equal(manifest.version, "1.2.0");
    assert.match(readmeText, /Version: v1\.2\.0/);
    assert.equal(packageJson.scripts?.package, "node scripts/package-extension.mjs");
    assert.equal(packageJson.repository?.url, "git+https://github.com/ariobarin/Eventy.git");
});

test("release verification includes live LLM integration", () => {
    assert.match(packageJson.scripts?.["verify:integration"] || "", /eval:real-pages:llm/);
    assert.match(packageJson.scripts?.["verify:integration"] || "", /--proxy-url=https:\/\/eventy-proxy\.eventy\.workers\.dev\/api/);
    assert.match(packageJson.scripts?.["verify:integration"] || "", /city-of-sydney-whats-on/);
    assert.match(packageJson.scripts?.["verify:integration"] || "", /mcasd-events/);
    assert.match(packageJson.scripts?.["verify:release"] || "", /verify:integration/);
});

test("model listing does not send the user api key", () => {
    const settingsSource = fs.readFileSync(new URL("../src/ui/settings/api.js", import.meta.url), "utf8");
    assert.equal(settingsSource.includes('postProxyJson("/models", { apiKey })'), false);
    assert.match(settingsSource, /postProxyJson\("\/models"\)/);
});
