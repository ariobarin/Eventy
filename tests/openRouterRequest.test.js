import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenRouterRequestBody } from "../src/llm/client.js";

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
