import test from "node:test";
import assert from "node:assert/strict";

import {
    buildEventExtractionMessages,
    buildOpenRouterRequestBody,
    extractEventsFromStructuredOutput,
} from "../src/llm/client.js";

test("completion request uses strict structured outputs", () => {
    const body = buildOpenRouterRequestBody([
        { role: "user", content: "extract events" },
    ]);

    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(
        body.response_format.json_schema.schema.required,
        ["events"]
    );
});

test("completion request does not request streaming", () => {
    const body = buildOpenRouterRequestBody([
        { role: "user", content: "extract events" },
    ]);

    assert.equal(Object.hasOwn(body, "stream"), false);
});

test("completion request requires routed providers to support parameters", () => {
    const body = buildOpenRouterRequestBody([
        { role: "user", content: "extract events" },
    ]);

    assert.deepEqual(body.provider, { require_parameters: true });
});

test("event schema uses required nullable optional fields", () => {
    const body = buildOpenRouterRequestBody([
        { role: "user", content: "extract events" },
    ]);
    const eventSchema =
        body.response_format.json_schema.schema.properties.events.items;

    assert.deepEqual(eventSchema.required, [
        "title",
        "preview",
        "startDate",
        "startTime",
        "endDate",
        "endTime",
        "location",
        "description",
        "recurrence",
    ]);
    assert.deepEqual(eventSchema.properties.startTime.type, ["string", "null"]);
    assert.deepEqual(eventSchema.properties.endTime.type, ["string", "null"]);
    assert.deepEqual(eventSchema.properties.location.type, ["string", "null"]);
    assert.equal(eventSchema.additionalProperties, false);
});

test("event extraction messages include page context and compact inputs", () => {
    const messages = buildEventExtractionMessages({
        modelInput: "Opening Night\n\nJune 26, 2026",
        url: "https://example.test/events",
        context: { pageTitle: "Events", pageLang: "en" },
        csvSnippets: ['"Title","Date"\n"Opening Night","June 26, 2026"'],
    });

    assert.equal(messages[0].role, "system");
    assert.match(messages[1].content, /Current page URL: https:\/\/example\.test\/events/);
    assert.match(messages[1].content, /"pageTitle":"Events"/);
    assert.match(messages[2].content, /Preprocessed tables as CSV/);
    assert.match(messages[3].content, /Opening Night/);
    assert.match(messages.at(-1).content, /June 26, 2026/);
});

test("event extraction prompt prioritizes structured row fields", () => {
    const messages = buildEventExtractionMessages({
        modelInput: "Meeting Notes\nHEARING RESCHEDULED - NEW DATE JULY 1, 2026",
        url: "https://example.test/calendar",
        csvSnippets: [
            [
                '"Name","Meeting Date","Meeting Time","Meeting Topic"',
                '"Public Health & Environment Committee","6/24/2026","10:00 AM","HEARING RESCHEDULED - NEW DATE JULY 1, 2026"',
            ].join("\n"),
        ],
    });

    assert.match(
        messages[0].content,
        /row has explicit date\/time\/location fields/
    );
    assert.match(
        messages[0].content,
        /Dates mentioned only inside notes or descriptions are details/
    );
});

test("structured output parser extracts events from model responses", () => {
    const events = extractEventsFromStructuredOutput({
        choices: [
            {
                message: {
                    content: JSON.stringify({
                        events: [
                            {
                                title: "Opening Night",
                                preview: null,
                                startDate: "2026-06-26",
                                startTime: "7:00 PM",
                                endDate: null,
                                endTime: null,
                                location: "Main Hall",
                                description: null,
                                recurrence: null,
                            },
                        ],
                    }),
                },
            },
        ],
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].title, "Opening Night");
});
