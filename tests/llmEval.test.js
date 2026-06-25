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
                    labels: ["source-only audit marker"],
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
    assert.equal(Object.hasOwn(body, "temperature"), false);
    assert.equal(Object.hasOwn(body, "top_p"), false);
    assert.match(body.messages[0].content, /every supplied expected field/);
    assert.match(body.messages[0].content, /venue suffix/i);
    assert.match(body.messages[1].content, /Opening Night/);
    assert.match(body.messages[1].content, /extractedEvents/);
    assert.match(body.messages[1].content, /expectedEventsAreExhaustive/);
    assert.match(body.messages[1].content, /expectedIndex/);
    assert.doesNotMatch(body.messages[1].content, /source-only audit marker/);
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

test("LLM judge summary reconciles exact extracted events missed by judge", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Second Chance Seed Library",
                    extractedTitle: "Second Chance Seed Library",
                    reason: "Title and date match.",
                },
            ],
            misses: [
                {
                    expectedIndex: 1,
                    expectedTitle:
                        "In-Person One-to-One English Conversation (Reston Regional Library)",
                    reason:
                        "The extracted event has matching title, date, time, and location. It should be considered matched.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Second Chance Seed Library",
                    date: "June 22, 2026",
                    location: "John Marshall Library",
                },
                {
                    title:
                        "In-Person One-to-One English Conversation (Reston Regional Library)",
                    date: "June 23, 2026",
                    time: "10:00am - 11:00am",
                    location: "Reston Regional Library",
                },
            ],
            extractedEvents: [
                {
                    title: "Second Chance Seed Library",
                    startDate: "2026-06-22",
                    location: "John Marshall Library",
                },
                {
                    title:
                        "In-Person One-to-One English Conversation (Reston Regional Library)",
                    startDate: "2026-06-23",
                    startTime: "10:00am",
                    endTime: "11:00am",
                    location: "Reston Large Print Area, Reston Regional Library",
                },
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

test("LLM judge summary reconciles yearless expected dates by month and day", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
        const summary = summarizeJudgeVerdict(
            {
                passed: false,
                matches: [],
                misses: [
                    {
                        expectedIndex: 0,
                        expectedTitle: "Great Opera Hits 2026",
                        reason: "The event is present with the same month and day.",
                    },
                ],
                hallucinations: [],
            },
            {
                expectedEvents: [
                    {
                        title: "Great Opera Hits 2026",
                        date: "5 July",
                    },
                ],
                extractedEvents: [
                    {
                        title: "Great Opera Hits 2026",
                        startDate: "2026-07-05",
                    },
                ],
            }
        );

        assert.deepEqual(summary, {
            passed: true,
            matches: 1,
            misses: 0,
            hallucinations: 0,
        });
    } finally {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    }
});

test("LLM judge summary reconciles natural language dates across timezones", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
        const summary = summarizeJudgeVerdict(
            {
                passed: false,
                matches: [],
                misses: [
                    {
                        expectedIndex: 0,
                        expectedTitle: "Great Opera Hits 2026",
                        reason: "The event is present with the same date.",
                    },
                ],
                hallucinations: [],
            },
            {
                expectedEvents: [
                    {
                        title: "Great Opera Hits 2026",
                        date: "July 5, 2026",
                    },
                ],
                extractedEvents: [
                    {
                        title: "Great Opera Hits 2026",
                        startDate: "2026-07-05",
                    },
                ],
            }
        );

        assert.deepEqual(summary, {
            passed: true,
            matches: 1,
            misses: 0,
            hallucinations: 0,
        });
    } finally {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    }
});

test("LLM judge summary reconciles numeric slash dates across timezones", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
        const summary = summarizeJudgeVerdict(
            {
                passed: false,
                matches: [],
                misses: [
                    {
                        expectedIndex: 0,
                        expectedTitle: "Community Briefing",
                        reason: "The event is present with the same date.",
                    },
                ],
                hallucinations: [],
            },
            {
                expectedEvents: [
                    {
                        title: "Community Briefing",
                        date: "Monday, 6/22/2026",
                    },
                ],
                extractedEvents: [
                    {
                        title: "Community Briefing",
                        startDate: "2026-06-22",
                    },
                ],
            }
        );

        assert.deepEqual(summary, {
            passed: true,
            matches: 1,
            misses: 0,
            hallucinations: 0,
        });
    } finally {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    }
});

test("LLM judge summary does not reconcile date ranges missing an end date", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Summer Exhibition",
                    reason: "The extraction is missing the range end.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Summer Exhibition",
                    date: "June 29, 2026 - Jul 2, 2026",
                },
            ],
            extractedEvents: [
                {
                    title: "Summer Exhibition",
                    startDate: "2026-06-29",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile yearless date ranges missing an end date", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Summer Exhibition",
                    reason: "The extraction is missing the range end.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Summer Exhibition",
                    date: "May 19th - Aug 2nd",
                },
            ],
            extractedEvents: [
                {
                    title: "Summer Exhibition",
                    startDate: "2026-05-19",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile compact date ranges missing an end date", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Workshop Week",
                    reason: "The extraction is missing the range end.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Workshop Week",
                    date: "June 13-19",
                },
            ],
            extractedEvents: [
                {
                    title: "Workshop Week",
                    startDate: "2026-06-13",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile month-to-month ranges missing an end date", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Long Exhibition",
                    reason: "The extraction is missing the range end.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Long Exhibition",
                    date: "May 19th-Aug 2nd",
                },
            ],
            extractedEvents: [
                {
                    title: "Long Exhibition",
                    startDate: "2026-05-19",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary infers missing range years from the other endpoint", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Summer Festival",
                    reason: "The extracted start date is in the wrong year.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Summer Festival",
                    date: "June 11 to July 19, 2026",
                },
            ],
            extractedEvents: [
                {
                    title: "Summer Festival",
                    startDate: "2025-06-11",
                    endDate: "2026-07-19",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary reconciles complete date ranges", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Summer Exhibition",
                    reason: "The extraction includes both range ends.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Summer Exhibition",
                    date: "June 29, 2026 - Jul 2, 2026",
                },
            ],
            extractedEvents: [
                {
                    title: "Summer Exhibition",
                    startDate: "2026-06-29",
                    endDate: "2026-07-02",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary reconciles shorthand expected time ranges", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Market",
                    reason: "The extracted event has the correct expanded range.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Market",
                    time: "5-6 PM",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Market",
                    startTime: "5:00 PM",
                    endTime: "6:00 PM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary reconciles expected time ranges with timezone text", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Research Workshop",
                    reason: "The extracted event has the correct expanded range.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Research Workshop",
                    time: "5:15pm UTC - 8pm UTC",
                },
            ],
            extractedEvents: [
                {
                    title: "Research Workshop",
                    startTime: "5:15 PM",
                    endTime: "8:00 PM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary reconciles dotted-minute expected time ranges", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Gallery Tour",
                    reason: "The extracted event has the correct dotted-minute range.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Gallery Tour",
                    time: "11am - 11.45am",
                },
            ],
            extractedEvents: [
                {
                    title: "Gallery Tour",
                    startTime: "11:00 AM",
                    endTime: "11:45 AM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile dotted-minute ranges with wrong endpoints", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Gallery Tour",
                    reason: "The extracted end time is wrong.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Gallery Tour",
                    time: "11am - 11.45am",
                },
            ],
            extractedEvents: [
                {
                    title: "Gallery Tour",
                    startTime: "11:00 AM",
                    endTime: "11:00 AM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary reconciles dot-separated twenty-four-hour ranges", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Drop In",
                    reason: "The extracted event has the correct dot-separated range.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Drop In",
                    time: "08.00-11.00",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Drop In",
                    startTime: "08:00",
                    endTime: "11:00",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile dot-separated ranges with wrong starts", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Drop In",
                    reason: "The extracted start time is wrong.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Drop In",
                    time: "08.00-11.00",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Drop In",
                    startTime: "00:00",
                    endTime: "11:00",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary reconciles single-letter meridiem ranges", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Morning Session",
                    reason: "The extracted event has the correct compact range.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Morning Session",
                    time: "11a-12p",
                },
            ],
            extractedEvents: [
                {
                    title: "Morning Session",
                    startTime: "11:00 AM",
                    endTime: "12:00 PM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: true,
        matches: 1,
        misses: 0,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile single-letter meridiem ranges from descriptions", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Morning Session",
                    reason: "The extraction is missing structured time fields.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Morning Session",
                    time: "11a-12p",
                },
            ],
            extractedEvents: [
                {
                    title: "Morning Session",
                    description: "11a-12p",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile shorthand ranges missing an end time", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Market",
                    reason: "The extraction is missing the range end.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Market",
                    time: "5-6 PM",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Market",
                    startTime: "5",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile timezone ranges from descriptions", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Research Workshop",
                    reason: "The extraction is missing structured range fields.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Research Workshop",
                    time: "5:15pm UTC - 8pm UTC",
                },
            ],
            extractedEvents: [
                {
                    title: "Research Workshop",
                    description: "5:15pm UTC - 8pm UTC",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile timezone ranges from a single time field", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Research Workshop",
                    reason: "The extraction is missing separate structured range fields.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Research Workshop",
                    time: "5:15pm UTC - 8pm UTC",
                },
            ],
            extractedEvents: [
                {
                    title: "Research Workshop",
                    startTime: "5:15pm UTC - 8pm UTC",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile time ranges from a single start field", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Market",
                    reason: "The extraction is missing a separate structured end time.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Market",
                    time: "5-6 PM",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Market",
                    startTime: "5:00 PM - 6:00 PM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile time ranges from a single end field", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Market",
                    reason: "The extraction is missing a separate structured start time.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Market",
                    time: "5-6 PM",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Market",
                    endTime: "5:00 PM - 6:00 PM",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile expected time ranges from descriptions", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "Community Market",
                    reason: "The extraction is missing structured times.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "Community Market",
                    time: "5-6 PM",
                },
            ],
            extractedEvents: [
                {
                    title: "Community Market",
                    description: "Doors at 5-6 PM.",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM judge summary does not reconcile missing expected fields", () => {
    const summary = summarizeJudgeVerdict(
        {
            passed: false,
            matches: [],
            misses: [
                {
                    expectedIndex: 0,
                    expectedTitle: "DNewTech - July 2026",
                    reason: "The extracted event is missing recurrence.",
                },
            ],
            hallucinations: [],
        },
        {
            expectedEvents: [
                {
                    title: "DNewTech - July 2026",
                    date: "Wednesday, July 8, 2026",
                    time: "6:30 PM to 8:30 PM EDT",
                    location: "Tech Town Detroit",
                    recurrence: "2nd Wednesday of the month",
                },
            ],
            extractedEvents: [
                {
                    title: "DNewTech - July 2026",
                    startDate: "2026-07-08",
                    startTime: "6:30 PM",
                    endTime: "8:30 PM",
                    location: "Tech Town Detroit",
                },
            ],
        }
    );

    assert.deepEqual(summary, {
        passed: false,
        matches: 0,
        misses: 1,
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
        misses: 1,
        hallucinations: 0,
    });
});

test("LLM eval can use a proxy transport without exposing OpenRouter auth", () => {
    const transport = resolveEvalTransport({
        env: {
            EVENTY_EVAL_PROXY_URL: "https://example.test/api",
            EVENTY_EVAL_PROXY_TOKEN: "shared-token",
            OPENROUTER_API_KEY: "fake-openrouter-key",
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
