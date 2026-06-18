import test from "node:test";
import assert from "node:assert/strict";

test("protected Chrome pages explain why scanning cannot start", async () => {
    const tabAccess = await import("../src/utils/tabAccess.js").catch((err) => {
        assert.fail(`expected tab access helpers to exist: ${err.message}`);
    });

    assert.equal(
        tabAccess.getTabScanBlockReason("chrome://extensions/"),
        "Chrome pages cannot be scanned."
    );
    assert.equal(
        tabAccess.getTabScanBlockReason("https://chromewebstore.google.com/detail/eventy/example"),
        "Chrome Web Store pages cannot be scanned."
    );
    assert.equal(
        tabAccess.getTabScanBlockReason("https://example.com/events"),
        null
    );
    assert.equal(
        tabAccess.getRequiredTabScanBlockReason(""),
        "This page cannot be scanned."
    );
    assert.equal(tabAccess.getTabScanBlockReason(""), null);
});

test("script injection failures become user-facing scan messages", async () => {
    const tabAccess = await import("../src/utils/tabAccess.js").catch((err) => {
        assert.fail(`expected tab access helpers to exist: ${err.message}`);
    });

    assert.equal(
        tabAccess.getScriptInjectionFailureMessage(
            "https://chromewebstore.google.com/detail/eventy/example",
            new Error("The extensions gallery cannot be scripted.")
        ),
        "Chrome Web Store pages cannot be scanned."
    );
    assert.equal(
        tabAccess.getScriptInjectionFailureMessage(
            "https://example.com/events",
            new Error("The extensions gallery cannot be scripted.")
        ),
        "This page cannot be scanned."
    );
    assert.equal(
        tabAccess.getScriptInjectionFailureMessage(
            "https://example.com/events",
            new Error("Temporary network failure")
        ),
        null
    );
});
