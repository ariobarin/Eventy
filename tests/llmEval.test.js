import test from "node:test";
import assert from "node:assert/strict";

import {
    buildEventJudgeRequestBody,
    summarizeJudgeVerdict,
} from "../scripts/eval-real-pages-with-llm.mjs";

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
    assert.match(body.messages[1].content, /Opening Night/);
    assert.match(body.messages[1].content, /extractedEvents/);
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
