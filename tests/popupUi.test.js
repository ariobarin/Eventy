import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("scan button starts disabled until page availability is known", () => {
    const html = fs.readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
    const scanSectionTag = html.match(/<div id="scanSection"[^>]*>/)?.[0];
    const scanButtonTag = html.match(/<button id="scanBtn"[^>]*>/)?.[0];

    assert.ok(scanSectionTag, "scan section should exist");
    assert.ok(scanButtonTag, "scan button should exist");
    assert.match(scanSectionTag, /\bscan-unavailable\b/);
    assert.match(scanSectionTag, /title="Checking page scan availability\."/);
    assert.match(scanButtonTag, /\sdisabled(?:\s|>|=)/);
    assert.match(scanButtonTag, /title="Checking page scan availability\."/);
});

test("scan availability refresh disables the button while tab lookup is pending", () => {
    const js = fs.readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
    const start = js.indexOf("async function refreshScanAvailability(activeTab = null)");
    assert.notEqual(start, -1, "refresh helper should exist");
    const end = js.indexOf("function transitionToScanning()", start);
    assert.notEqual(end, -1, "refresh helper should precede scan transition");
    const helper = js.slice(start, end);

    assert.match(helper, /scanAvailabilityReady = false;/);
    assert.match(helper, /applyScanButtonAvailability\(\);/);
    assert.match(helper, /const tab = activeTab \|\| await getActiveTab\(\);/);
    assert.match(js, /scanBtn\.disabled = isBusy \|\| isUnavailable \|\| isChecking;/);
});

test("protected scan handling does not render a toast card", () => {
    const js = fs.readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
    const start = js.indexOf("if (isTabScanAccessError(e))");
    assert.notEqual(start, -1, "tab access error branch should exist");
    const end = js.indexOf("// Check if this is a rate limit error", start);
    assert.notEqual(end, -1, "tab access branch should be bounded");
    const branch = js.slice(start, end);

    assert.match(branch, /setScanAvailabilityReason\(e\.userMessage \|\| e\.message\);/);
    assert.doesNotMatch(branch, /showToast/);
});

test("disabled scan hover is delegated to the scan wrapper", () => {
    const css = fs.readFileSync(new URL("../src/ui/popup.css", import.meta.url), "utf8");

    assert.match(css, /\.scan-section\.scan-unavailable\s*{[\s\S]*cursor:\s*not-allowed;/);
    assert.match(css, /\.scan-section\.scan-unavailable \.primary-button\s*{[\s\S]*pointer-events:\s*none;/);
});

test("popup toast leaves layout after it fades out", () => {
    const js = fs.readFileSync(new URL("../src/popup/toast.js", import.meta.url), "utf8");

    assert.match(js, /toast\.classList\.remove\("visible"\);/);
    assert.match(js, /toast\.dataset\.hideTimeoutId = String\(setTimeout\(\(\) => {/);
    assert.match(js, /toast\.classList\.add\("hidden"\);/);
    assert.match(js, /clearTimeout\(Number\(toast\.dataset\.hideTimeoutId\)\);/);
});

test("popup tells iCalendar users to open downloaded files", () => {
    const js = fs.readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
    const start = js.indexOf("addSelectedBtn?.addEventListener");
    assert.notEqual(start, -1, "add selected handler should exist");
    const end = js.indexOf("// Check if a scan is in progress", start);
    assert.notEqual(end, -1, "add selected handler should be bounded");
    const handler = js.slice(start, end);

    assert.match(handler, /onIcsDownloadStarted/);
    assert.match(handler, /After it downloads, open the \.ics file/);
    assert.match(handler, /showToast\(/);
});
