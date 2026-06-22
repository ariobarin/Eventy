import test from "node:test";
import assert from "node:assert/strict";

test("settings api formats known provider labels", async () => {
    const { formatProviderName } = await import("../src/ui/settings/api.js");

    assert.equal(formatProviderName("openai"), "OpenAI");
    assert.equal(formatProviderName("meta-llama"), "Meta Llama");
    assert.equal(formatProviderName("new-provider"), "New-provider");
});

test("settings api detects api key balance from proxy data", async () => {
    const { getApiKeyBalanceStatus } = await import("../src/ui/settings/api.js");

    assert.deepEqual(
        getApiKeyBalanceStatus({ limit: "10", usage: "4" }),
        { hasBalance: true, limit: 10, usage: 4, remaining: 6 }
    );
    assert.deepEqual(
        getApiKeyBalanceStatus({ limit_remaining: "0", limit: "10", usage: "10" }),
        { hasBalance: false, limit: 10, usage: 10, remaining: 0 }
    );
    assert.deepEqual(
        getApiKeyBalanceStatus({ usage: "1" }),
        { hasBalance: true, limit: null, usage: 1, remaining: null }
    );
});
