import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("scan button exists in toolbar", () => {
    const html = fs.readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
    const scanButtonTag = html.match(/<button id="scanBtn"[^>]*>/)?.[0];

    assert.ok(scanButtonTag, "scan button should exist");
    assert.match(scanButtonTag, /toolbar-btn/);
    assert.match(scanButtonTag, /title="Scan this page"/);
});

test("scan availability refresh disables the button while tab lookup is pending", () => {
    const js = fs.readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
    const start = js.indexOf("async function refreshScanAvailability(");
    assert.notEqual(start, -1, "refresh helper should exist");
    const end = js.indexOf("function switchTab(", start);
    assert.notEqual(end, -1, "refresh helper should precede switchTab");
    const helper = js.slice(start, end);

    assert.match(helper, /scanAvailabilityReady = false;/);
    assert.match(helper, /applyScanButtonAvailability\(\);/);
    assert.match(js, /scanBtn\.disabled = isBusy \|\| isUnavailable \|\| isChecking;/);
});

test("protected scan handling does not render a toast card", () => {
    const js = fs.readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
    const start = js.indexOf("if (isTabScanAccessError(e))");
    assert.notEqual(start, -1, "tab access error branch should exist");
    const end = js.indexOf('if (e.name === "RateLimitError"', start);
    assert.notEqual(end, -1, "tab access branch should be bounded by rate limit check");
    const branch = js.slice(start, end);

    assert.match(branch, /setScanAvailabilityReason\(e\.userMessage \|\| e\.message\);/);
    assert.doesNotMatch(branch, /showToast/);
});

test("toolbar scan button has unavailable styling", () => {
    const css = fs.readFileSync(new URL("../src/ui/popup.css", import.meta.url), "utf8");

    assert.match(css, /\.toolbar-btn\.scan-unavailable\s*{[\s\S]*cursor:\s*not-allowed;/);
    assert.match(css, /\.toolbar-btn:disabled\s*{[\s\S]*cursor:\s*not-allowed;/);
});

test("popup toast leaves layout after it fades out", () => {
    const js = fs.readFileSync(new URL("../src/popup/toast.js", import.meta.url), "utf8");

    assert.match(js, /toast\.classList\.remove\("visible"\);/);
    assert.match(js, /toast\.dataset\.hideTimeoutId = String\(setTimeout\(\(\) => {/);
    assert.match(js, /toast\.classList\.add\("hidden"\);/);
    assert.match(js, /clearTimeout\(Number\(toast\.dataset\.hideTimeoutId\)\);/);
});
