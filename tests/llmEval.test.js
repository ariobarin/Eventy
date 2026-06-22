import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildErroredEvalPage,
    buildEvalTransportRequest,
    buildEventJudgeRequestBody,
    resolveEvalTransport,
    summarizeJudgeVerdict,
} from "../scripts/eval-real-pages-with-llm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalScriptPath = path.join(repoRoot, "scripts", "eval-real-pages-with-llm.mjs");

test("LLM judge request uses strict structured output", () => {
    const body = buildEventJudgeRequestBody({
        model: "test/model",
        fixture: {
            name: "sample-page",
            url: "https://example.test/events",
            expectedEvents: [
                {
                    title: "Opening Night",
                    date: "June 26, 2026",
                    location: "Main Hall",
                },
            ],
        },
        extractedEvents: [
            {
                title: "Opening Night",
                startDate: "2026-06-26",
                location: "Main Hall",
            },
        ],
    });

    assert.equal(body.model, "test/model");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(Object.hasOwn(body, "stream"), false);
    assert.match(body.messages[0].content, /venue suffix/i);
    assert.match(body.messages[1].content, /Opening Night/);
    assert.match(body.messages[1].content, /extractedEvents/);
    assert.match(body.messages[1].content, /expectedEventsAreExhaustive/);
    assert.match(body.messages[1].content, /expectedIndex/);
});

test("LLM judge summary counts matches, misses, and hallucinations", () => {
    const summary = summarizeJudgeVerdict({
        passed: false,
        matches: [{ expectedTitle: "Opening Night" }],
        misses: [{ expectedTitle: "Closing Talk" }],
        hallucinations: [{ extractedTitle: "Made Up Event" }],
    });

    assert.deepEqual(summary, {
        passed: false,
        matches: 1,
        misses: 1,
        hallucinations: 1,
    });
});

test("LLM judge summary treats expected events as non-exhaustive labels", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: true,
            matches: [
                { expectedTitle: "Pedalpalooza Kickoff Ride" },
                { expectedTitle: "Big Pride Ride" },
            ],
            misses: [],
            hallucinations: [
                { extractedTitle: "Other source-visible event" },
            ],
        },
        { expectedEventCount: 2 }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 2,
        misses: 0,
        hallucinations: 1,
    });
});

test("LLM judge summary ignores extra matches outside expected labels", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Kenton Farmers Market",
                    extractedTitle: "Kenton Farmers Market",
                },
                {
                    expectedIndex: 1,
                    expectedTitle: "South Waterfront Farmers Market",
                    extractedTitle: "South Waterfront Farmers Market",
                },
                {
                    expectedTitle: "Void Tattoo Fest Street Fair",
                    extractedTitle: null,
                },
            ],
            misses: [],
            hallucinations: [],
        },
        {
            expectedEventCount: 2,
            expectedEvents: [
                { title: "Kenton Farmers Market" },
                { title: "South Waterfront Farmers Market" },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 2,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary resolves contradictory misses for matched labels", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: true,
            matches: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Great Opera Hits 2026",
                    extractedTitle: "Great Opera Hits 2026",
                },
            ],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Great Opera Hits 2026",
                    reason: "The event is present, so this is not a miss.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEventCount: 1,
            expectedEvents: [{ title: "Great Opera Hits 2026" }],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary fails missing expected evidence", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [{ expectedIndex: 0, expectedTitle: "Gump Fiction" }],
            hallucinations: [],
        },
        {
            expectedEventCount: 1,
            expectedEvents: [{ title: "Gump Fiction" }],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary fails incomplete expected matches", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: true,
            matches: [{ expectedTitle: "Opening Night" }],
            misses: [],
            hallucinations: [],
        },
        { expectedEventCount: 2 }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM eval can use a proxy transport without exposing OpenRouter auth", () => {
    const transport = resolveEvalTransport({
        env: {
            EVENTY_EVAL_PROXY_URL: "https://example.test/api",
            EVENTY_EVAL_PROXY_TOKEN: "shared-token",
            OPENROUTER_API_KEY: "sk-or-v1-raw-key",
        },
    });
    const request = buildEvalTransportRequest({
        transport,
        body: { model: "deepseek/deepseek-v4-flash", messages: [] },
    });

    assert.equal(transport.mode, "proxy");
    assert.equal(request.url, "https://example.test/api");
    assert.equal(request.headers["X-Eventy-Token"], "shared-token");
    assert.equal(Object.hasOwn(request.headers, "Authorization"), false);
});

test("LLM eval rejects proxy tokens in cli args", () => {
    const result = spawnSync(
        process.execPath,
        [evalScriptPath, "--proxy-token=secret-token"],
        {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                EVENTY_EVAL_PROXY_URL: "",
                EVENTY_EVAL_PROXY_TOKEN: "",
                EVENTY_TOKEN: "",
                EVENTY_EVAL_OPENROUTER_API_KEY: "",
                OPENROUTER_API_KEY: "",
            },
        }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option: --proxy-token/);
});

test("LLM eval records page-level errors", () => {
    const page = buildErroredEvalPage({
        fixture: {
            name: "sample-page",
            url: "https://example.test/events",
            expectedEvents: [{ title: "Opening Night" }],
        },
        model: "deepseek/deepseek-v4-flash",
        judgeModel: "deepseek/deepseek-v4-flash",
        error: new Error("request timed out"),
    });

    assert.deepEqual(
        {
            name: page.name,
            passed: page.passed,
            matches: page.matches,
            misses: page.misses,
            hallucinations: page.hallucinations,
            error: page.error,
        },
        {
            name: "sample-page",
            passed: false,
            matches: 0,
            misses: 1,
            hallucinations: 0,
            error: "request timed out",
        }
    );
});
