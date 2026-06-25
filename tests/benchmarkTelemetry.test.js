import test from "node:test";
import assert from "node:assert/strict";

import {
    buildLLMCallTelemetry,
    summarizeLLMBenchmarkTelemetry,
} from "../scripts/benchmark-telemetry.mjs";

test("LLM benchmark telemetry records timing usage cost and throughput", () => {
    const telemetry = buildLLMCallTelemetry({
        metadata: {
            pageName: "sample-page",
            variant: "current",
            phase: "extract",
            attempt: 1,
        },
        transportMode: "openrouter",
        body: {
            model: "deepseek/deepseek-v4-flash",
            messages: [
                { role: "system", content: "Extract events." },
                { role: "user", content: "Concert Friday at 7 PM." },
            ],
            temperature: 0,
            response_format: { type: "json_schema" },
        },
        responseStatus: 200,
        responseStatusText: "OK",
        responseData: {
            id: "gen-123",
            model: "morph/deepseek-v4-flash",
            choices: [{ finish_reason: "stop", native_finish_reason: "stop" }],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 25,
                total_tokens: 125,
                prompt_tokens_details: {
                    cached_tokens: 40,
                    cache_creation_tokens: 5,
                },
                completion_tokens_details: {
                    reasoning_tokens: 3,
                },
                cost: 0.00125,
            },
        },
        responseText: '{"id":"gen-123"}',
        startedAt: "2026-06-24T01:00:00.000Z",
        responseStartedAt: "2026-06-24T01:00:00.300Z",
        endedAt: "2026-06-24T01:00:00.500Z",
        startedAtMs: 1000,
        responseStartedAtMs: 1300,
        endedAtMs: 1500,
    });

    assert.equal(telemetry.pageName, "sample-page");
    assert.equal(telemetry.variant, "current");
    assert.equal(telemetry.phase, "extract");
    assert.equal(telemetry.transportMode, "openrouter");
    assert.equal(telemetry.timing.durationMs, 500);
    assert.equal(telemetry.timing.timeToFirstResponseMs, 300);
    assert.equal(telemetry.timing.responseReadMs, 200);
    assert.equal(telemetry.request.model, "deepseek/deepseek-v4-flash");
    assert.equal(telemetry.request.messageCount, 2);
    assert.equal(telemetry.request.promptChars, 38);
    assert.equal(telemetry.request.responseFormat, "json_schema");
    assert.equal(telemetry.response.id, "gen-123");
    assert.equal(telemetry.response.finishReason, "stop");
    assert.equal(telemetry.usage.inputTokens, 100);
    assert.equal(telemetry.usage.outputTokens, 25);
    assert.equal(telemetry.usage.totalTokens, 125);
    assert.equal(telemetry.usage.cachedInputTokens, 40);
    assert.equal(telemetry.usage.cacheCreationInputTokens, 5);
    assert.equal(telemetry.usage.reasoningTokens, 3);
    assert.equal(telemetry.usage.costUsd, 0.00125);
    assert.equal(telemetry.throughput.outputTokensPerSecond, 50);
    assert.equal(telemetry.throughput.totalTokensPerSecond, 250);
});

test("LLM benchmark telemetry summary keeps totals and missing-field coverage", () => {
    const success = buildLLMCallTelemetry({
        metadata: { pageName: "sample-page", phase: "extract" },
        transportMode: "openrouter",
        body: {
            model: "test/model",
            messages: [{ role: "user", content: "hello" }],
        },
        responseStatus: 200,
        responseData: {
            usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                prompt_tokens_details: { cached_tokens: 4 },
                cost: 0.0001,
            },
        },
        responseText: "{}",
        startedAtMs: 0,
        responseStartedAtMs: 100,
        endedAtMs: 500,
    });
    const failed = buildLLMCallTelemetry({
        metadata: { pageName: "sample-page", phase: "judge" },
        transportMode: "openrouter",
        body: {
            model: "test/model",
            messages: [{ role: "user", content: "judge" }],
        },
        responseStatus: 500,
        responseStatusText: "Server Error",
        responseText: "upstream error",
        startedAtMs: 600,
        responseStartedAtMs: 700,
        endedAtMs: 800,
        error: new Error("upstream error"),
    });

    const summary = summarizeLLMBenchmarkTelemetry([success, failed], {
        startedAt: "2026-06-24T01:00:00.000Z",
        endedAt: "2026-06-24T01:00:01.000Z",
        startedAtMs: 0,
        endedAtMs: 1000,
    });

    assert.equal(summary.run.durationMs, 1000);
    assert.equal(summary.requests.total, 2);
    assert.equal(summary.requests.succeeded, 1);
    assert.equal(summary.requests.failed, 1);
    assert.equal(summary.payload.promptChars.mean, 5);
    assert.equal(summary.payload.responseBodyBytes.withValue, 2);
    assert.equal(summary.tokens.inputTokens, 10);
    assert.equal(summary.tokens.outputTokens, 5);
    assert.equal(summary.tokens.totalTokens, 15);
    assert.equal(summary.tokens.cachedInputTokens, 4);
    assert.equal(summary.cost.usd, 0.0001);
    assert.equal(summary.coverage.usage.withValue, 1);
    assert.equal(summary.coverage.usage.missing, 1);
    assert.equal(summary.coverage.timeToFirstResponseMs.withValue, 2);
    assert.equal(summary.coverage.costUsd.withValue, 1);
    assert.equal(summary.coverage.costUsd.missing, 1);
    assert.equal(summary.throughput.outputTokensPerSecond.mean, 10);
});
