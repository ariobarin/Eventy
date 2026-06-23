import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

import {
    buildModelInput,
    htmlToMarkdown,
    MODEL_INPUT_MAX_CHARS,
    tablesToCsvSnippets,
} from "../src/llm/preprocess.js";

test("model input keeps event details while dropping repeated low-value page text", () => {
    const repeatedNoise = Array.from(
        { length: 420 },
        (_, index) => `Navigation link ${index} privacy terms careers subscribe`
    ).join("\n\n");
    const eventDetails = [
        "Rooftop Film Night",
        "Friday June 26, 2026",
        "Doors 7:00 PM, screening 8:15 PM",
        "Location: 123 Queen Street West",
        "Tickets include reserved seating and a post-show Q&A.",
    ].join("\n\n");
    const input = `${repeatedNoise}\n\n${eventDetails}\n\n${repeatedNoise}`;

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.ok(output.length < input.length / 3);
    assert.match(output, /Rooftop Film Night/);
    assert.match(output, /Friday June 26, 2026/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /123 Queen Street West/);
    assert.doesNotMatch(output, /Navigation link 419/);
});

test("model input does not clip long text that is already under budget", () => {
    const intro = "General event notes ".repeat(90);
    const eventDetails =
        "Community Market June 26, 2026 at 7:00 PM in Main Hall";
    const input = `${intro}${eventDetails}`;

    const output = buildModelInput(input, null);

    assert.ok(input.length < MODEL_INPUT_MAX_CHARS);
    assert.equal(output, input);
    assert.match(output, /Community Market June 26, 2026 at 7:00 PM/);
});

test("model input preserves tail signals inside long selected blocks", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const longEventBlock = [
        "Community Planning Session",
        "Background notes ".repeat(140),
        "Friday June 26, 2026 at 7:00 PM in Main Hall",
    ].join(" ");
    const input = [repeatedNoise, longEventBlock, repeatedNoise].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Community Planning Session/);
    assert.match(output, /Friday June 26, 2026/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input preserves middle signals inside long selected blocks", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const longEventBlock = [
        "Hidden Garden Workshop",
        "Introductory background notes ".repeat(90),
        "Friday June 26, 2026 at 7:00 PM",
        "Location: Hidden Garden Room",
        "Additional attendee guidance ".repeat(90),
    ].join(" ");
    const input = [repeatedNoise, longEventBlock, repeatedNoise].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Hidden Garden Workshop/);
    assert.match(output, /Friday June 26, 2026/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Hidden Garden Room/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input prioritizes date and time signals when clipping long blocks", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const longEventBlock = [
        "Deep Context Workshop",
        "event ticket registration venue ".repeat(90),
        "Friday June 26, 2026 at 7:00 PM",
        "Location: Main Hall",
        "Additional attendee guidance ".repeat(90),
    ].join(" ");
    const input = [repeatedNoise, longEventBlock, repeatedNoise].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Deep Context Workshop/);
    assert.match(output, /Friday June 26, 2026/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input preserves later signals inside serialized event blocks", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const serializedEventBlock = Array.from({ length: 18 }, (_, index) =>
        [
            `Serialized Event ${index}`,
            `Friday June ${(index % 28) + 1}, 2026`,
            "7:00 PM",
            `Location: Room ${index}`,
            "Tickets and registration details are available now.",
        ].join(" ")
    ).join(" ");
    const input = [repeatedNoise, serializedEventBlock, repeatedNoise].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Serialized Event 0/);
    assert.match(output, /Serialized Event 12/);
    assert.match(output, /Friday June 13, 2026/);
    assert.match(output, /Room 12/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input preserves dense serialized event feeds over block budget", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const serializedEventBlock = Array.from({ length: 40 }, (_, index) =>
        [
            `Dense Serialized Event ${index}.`,
            `Friday June ${(index % 28) + 1}, 2026.`,
            "7:00 PM.",
            `Location: Room ${index}.`,
            "Tickets and registration details are available now.",
        ].join(" ")
    ).join(" ");
    const input = [repeatedNoise, serializedEventBlock, repeatedNoise].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Dense Serialized Event 0/);
    assert.match(output, /Dense Serialized Event 12/);
    assert.match(output, /Dense Serialized Event 24/);
    assert.match(output, /Dense Serialized Event 36/);
    assert.match(output, /Room 36/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input preserves leading page-level event context", () => {
    const leadingContext = [
        "DATE 2026",
        "20 - 22 April 2026",
        "Verona, Italy",
    ].join("\n\n");
    const denseEvents = Array.from({ length: 360 }, (_, index) =>
        [
            `Dense Agenda Session ${index}`,
            `Friday June ${(index % 28) + 1}, 2026`,
            `${(index % 12) + 1}:00 PM`,
            `Room ${index}`,
            "Conference session workshop details.",
        ].join("\n\n")
    ).join("\n\n");

    const output = buildModelInput(`${leadingContext}\n\n${denseEvents}`, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /DATE 2026/);
    assert.match(output, /20 - 22 April 2026/);
});

test("model input keeps day-first dates with adjacent event context", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const input = [
        repeatedNoise,
        "Art Crawl",
        "26 June 2026",
        "Main Hall",
        repeatedNoise,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Art Crawl/);
    assert.match(output, /26 June 2026/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input keeps ordinal dates during ranking", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const input = [
        repeatedNoise,
        "Solstice Workshop",
        "June 21st, 2026",
        "Main Hall",
        repeatedNoise,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Solstice Workshop/);
    assert.match(output, /June 21st, 2026/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input keeps relative-date event cards", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const input = [
        repeatedNoise,
        "Midnight Gallery Opening",
        "Tonight",
        "Main Hall",
        repeatedNoise,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Midnight Gallery Opening/);
    assert.match(output, /Tonight/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input keeps month headers for split calendar dates", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const input = [
        repeatedNoise,
        "June",
        "26",
        "7:00 PM",
        "Community Market",
        "Main Plaza",
        repeatedNoise,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /June/);
    assert.match(output, /26/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Community Market/);
    assert.match(output, /Main Plaza/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input keeps month headers for month day title time cards", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const input = [
        repeatedNoise,
        "June",
        "26",
        "Community Market",
        "7:00 PM",
        "Main Plaza",
        repeatedNoise,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /June/);
    assert.match(output, /26/);
    assert.match(output, /Community Market/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Main Plaza/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input keeps untimed month day title cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "June",
        "26",
        "Community Market",
        "Main Plaza",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /June/);
    assert.match(output, /26/);
    assert.match(output, /Community Market/);
    assert.match(output, /Main Plaza/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps untimed day month title cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "26",
        "June",
        "Community Market",
        "Main Plaza",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /26/);
    assert.match(output, /June/);
    assert.match(output, /Community Market/);
    assert.match(output, /Main Plaza/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps split month day year cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "Open Studio Night",
        "June",
        "23, 2026",
        "Online",
        "Closing Studio Night",
        "23rd, 2026",
        "Jun",
        "Main Hall",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Open Studio Night/);
    assert.match(output, /June/);
    assert.match(output, /23, 2026/);
    assert.match(output, /Online/);
    assert.match(output, /Closing Studio Night/);
    assert.match(output, /23rd, 2026/);
    assert.match(output, /Jun/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps titles before standalone month day cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "Open Studio Night",
        "June",
        "26",
        "Online",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Open Studio Night/);
    assert.match(output, /June/);
    assert.match(output, /26/);
    assert.match(output, /Online/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps long titles before standalone month day cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const longTitle =
        "An evening of new voices sharing stories from the neighborhood through memory food photography and conversation";
    const input = [
        repeatedCopy,
        longTitle,
        "June",
        "26",
        "Online",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, new RegExp(longTitle));
    assert.match(output, /June/);
    assert.match(output, /26/);
    assert.match(output, /Online/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps punctuated titles before standalone date cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "Mamma Mia!",
        "June",
        "26",
        "Online",
        "What Now?",
        "26",
        "June",
        "Main Hall",
        "Dr. Strangelove.",
        "July",
        "3",
        "Cinema 2",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Mamma Mia!/);
    assert.match(output, /What Now\?/);
    assert.match(output, /Dr\. Strangelove\./);
    assert.match(output, /Online/);
    assert.match(output, /Main Hall/);
    assert.match(output, /Cinema 2/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps titles before labeled standalone month day cards", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "Blue Velvet",
        "Date",
        "June",
        "26",
        "7:00 PM",
        "Main Hall",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Blue Velvet/);
    assert.match(output, /Date/);
    assert.match(output, /June/);
    assert.match(output, /26/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input keeps event titles two blocks before dates", () => {
    const repeatedNoise = Array.from(
        { length: 520 },
        (_, index) => `Navigation item ${index} privacy policy subscribe`
    ).join("\n\n");
    const input = [
        repeatedNoise,
        "Blue Velvet",
        "Tickets are available from the box office.",
        "Friday June 26, 2026",
        "7:00 PM",
        "Location: Main Hall",
        repeatedNoise,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Blue Velvet/);
    assert.match(output, /Friday June 26, 2026/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Navigation item 519/);
});

test("model input keeps event titles three blocks before dates", () => {
    const repeatedCopy = Array.from(
        { length: 520 },
        (_, index) =>
            `Community resource section ${index} with general visitor information and local program summaries.`
    ).join("\n\n");
    const input = [
        repeatedCopy,
        "Evening Gallery Walk",
        "Tickets are available from the box office.",
        "Doors open before the program begins.",
        "Friday June 26, 2026",
        "7:00 PM",
        "Location: Main Hall",
        repeatedCopy,
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Evening Gallery Walk/);
    assert.match(output, /Friday June 26, 2026/);
    assert.match(output, /7:00 PM/);
    assert.match(output, /Main Hall/);
    assert.doesNotMatch(output, /Community resource section 519/);
});

test("model input preserves repeated dates and locations for distinct events", () => {
    const input = [
        "Opening Night",
        "26 June 2026",
        "Main Hall",
        "Closing Night",
        "26 June 2026",
        "Main Hall",
    ].join("\n\n");

    const output = buildModelInput(input, null);

    assert.equal(output, input);
    assert.equal((output.match(/26 June 2026/g) || []).length, 2);
    assert.equal((output.match(/Main Hall/g) || []).length, 2);
    assert.match(output, /Closing Night\n\n26 June 2026\n\nMain Hall/);
});

test("model input marks shortened event-heavy pages", () => {
    const input = Array.from({ length: 260 }, (_, index) =>
        [
            `Long Calendar Event ${index}`,
            `Friday June ${(index % 28) + 1}, 2026`,
            "7:00 PM",
            `Location: Main Hall ${index}`,
            "Tickets are available from the box office.",
        ].join("\n\n")
    ).join("\n\n");

    const output = buildModelInput(input, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Context shortened/);
    assert.match(output, /some events or details may be omitted/i);
});

test("model input reserves truncation notice budget before selecting event blocks", () => {
    const leadCopy = Array.from(
        { length: 10 },
        (_, index) =>
            `Visitor information ${index} general copy general copy general copy general copy general copy general copy`
    ).join("\n\n");
    const events = Array.from({ length: 134 }, (_, index) =>
        [
            `Reserved Budget Event ${index}`,
            `Friday June ${(index % 28) + 1}, 2026`,
            `${(index % 12) + 1}:17 PM`,
            `Location: Budget Hall ${index}`,
            "Tickets are available from the box office.",
        ].join("\n\n")
    ).join("\n\n");
    const output = buildModelInput(`${leadCopy}\n\n${events}`, null);

    assert.ok(output.length <= MODEL_INPUT_MAX_CHARS);
    assert.match(output, /Context shortened/);
    assert.match(output, /Reserved Budget Event 133/);
    assert.match(output, /Friday June 22, 2026/);
    assert.match(output, /2:17 PM/);
    assert.match(output, /Location: Budget Hall 133/);
});

test("html conversion does not prefer generic content chrome over page content", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const output = htmlToMarkdown([
            "<body>",
            "<div class=\"content\">Search Login Subscribe</div>",
            "<div class=\"page-content\">",
            "<h1>Community Film Night</h1>",
            "<p>Friday June 26, 2026 at 7:00 PM</p>",
            "</div>",
            "</body>",
        ].join(""));

        assert.match(output, /Community Film Night/);
        assert.match(output, /Friday June 26, 2026/);
        assert.doesNotMatch(output, /^Search Login Subscribe$/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input prefers text over raw html when html parsing is unavailable", () => {
    assert.equal(typeof DOMParser, "undefined");

    const output = buildModelInput(
        "Workshop Night\n\nJune 29, 2026\n\n7:00 PM\n\nLocation: Main Hall",
        "<main><h1>Workshop Night</h1><script>window.largeTrackingPayload = true;</script></main>"
    );

    assert.match(output, /Workshop Night/);
    assert.match(output, /June 29, 2026/);
    assert.doesNotMatch(output, /<main>/);
    assert.doesNotMatch(output, /largeTrackingPayload/);
});

test("model input falls back to captured text when parsed html is sparse", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const output = buildModelInput(
            [
                "Community Market",
                "June 24, 2026",
                "5:00 PM",
                "Main Plaza",
                "Live music and local vendors",
            ].join("\n\n"),
            "<main><a href=\"#mainContent\">Skip to main content</a></main>"
        );

        assert.match(output, /Community Market/);
        assert.match(output, /June 24, 2026/);
        assert.match(output, /Main Plaza/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input prefers rendered text over bulky duplicate html", () => {
    const originalDomParser = globalThis.DOMParser;
    const noisyHtml = Array.from(
        { length: 700 },
        (_, index) =>
            `<p>Archive listing ${index} privacy account repeated navigation copy</p>`
    ).join("");
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const output = buildModelInput(
            [
                "Opening Panel",
                "June 24, 2026",
                "10:00 AM",
                "Room 101",
                "Closing Workshop",
                "June 25, 2026",
                "2:00 PM",
                "Room 202",
            ].join("\n\n"),
            `<main>${noisyHtml}</main>`
        );

        assert.match(output, /Opening Panel/);
        assert.match(output, /Closing Workshop/);
        assert.doesNotMatch(output, /Archive listing 699/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input prefers complete rendered text when it fits budget", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const text = [
            "All Upcoming Events",
            "June 27, 2026",
            "Visible Rendered Event",
            "Main Theater",
        ].join("\n\n");
        const html = [
            "<main>",
            "<h1>All Upcoming Events</h1>",
            "<p>June 27, 2026</p>",
            "<p>Generic HTML Event</p>",
            "<p>Main Theater</p>",
            "</main>",
        ].join("");

        const output = buildModelInput(text, html);

        assert.match(output, /Visible Rendered Event/);
        assert.doesNotMatch(output, /Generic HTML Event/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input keeps hidden html event details over sparse rendered chrome", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const text = [
            "Events Happening at Civic Square",
            "Hear music? Spot a crowd? Wondering what is happening at Civic Square?",
            "The Square is a bustling civic space with community and special events popping up throughout the year. Whether you are passing through or coming to visit, explore the schedule below to find out what is happening today and in the days ahead.",
            "For more details about each event, click the linked event organizer website or social media channel.",
            "Please note, this schedule is not a tool for determining availability. Learn how to book Civic Square.",
            "Expand All",
            "Events Happening at Civic Square accordion panels",
            "Collapse All",
            "Events Happening at Civic Square accordion panels",
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "Date modified: June 5, 2026",
        ].join("\n\n");
        const html = [
            "<main>",
            "<h1>Events Happening at Civic Square</h1>",
            Array.from(
                { length: 80 },
                (_, index) =>
                    `<p>General municipal services note ${index} with booking guidance and public information.</p>`
            ).join(""),
            "<section>",
            "<h2>June</h2>",
            "<article>",
            "<h3>TOgether 2026</h3>",
            "<p>June 5 to 6</p>",
            "<p>Nathan Phillips Square</p>",
            "</article>",
            "<article>",
            "<h3>Summer Market</h3>",
            "<p>June 12</p>",
            "<p>Civic Square</p>",
            "</article>",
            "</section>",
            "</main>",
        ].join("");

        const output = buildModelInput(text, html);

        assert.match(output, /TOgether 2026/);
        assert.match(output, /June 5 to 6/);
        assert.match(output, /Nathan Phillips Square/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input prefers near-budget rendered text over noisy markdown", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const renderedNoise = Array.from(
            { length: 430 },
            (_, index) => `Rendered archive note ${index} privacy account footer`
        ).join("\n\n");
        const htmlNoise = Array.from(
            { length: 360 },
            (_, index) =>
                `<p>Generic HTML event listing ${index} Friday June 26, 2026 7:00 PM tickets account</p>`
        ).join("");
        const text = [
            "Rendered Dense Calendar",
            "Rendered Dense Event",
            "Friday June 26, 2026",
            "7:00 PM",
            "Main Theater",
            renderedNoise,
        ].join("\n\n");
        const html = `<main><h1>Generic HTML Calendar</h1>${htmlNoise}</main>`;

        assert.ok(text.length > MODEL_INPUT_MAX_CHARS);
        assert.ok(text.length < MODEL_INPUT_MAX_CHARS * 1.35);

        const output = buildModelInput(text, html);

        assert.match(output, /Rendered Dense Event/);
        assert.match(output, /Friday June 26, 2026/);
        assert.match(output, /Main Theater/);
        assert.doesNotMatch(output, /Generic HTML Calendar/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input keeps non-accordion hidden html events over weak rendered text", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const renderedNoise = Array.from({ length: 320 }, (_, index) =>
            [
                `July ${String((index % 28) + 1)}, 2026`,
                `${(index % 12) + 1}:00 PM`,
                "View Details",
            ].join("\n")
        ).join("\n\n");
        const htmlNoise = Array.from(
            { length: 260 },
            (_, index) =>
                `<p>General event directory ${index} with calendar date and visitor information.</p>`
        ).join("");
        const text = [
            "Civic Arts Calendar",
            "Browse upcoming community events.",
            "For more information, select view details.",
            renderedNoise,
        ].join("\n\n");
        const html = [
            "<main>",
            "<h1>Civic Arts Calendar</h1>",
            htmlNoise,
            "<article>",
            "<h2>Hidden Jazz Workshop</h2>",
            "<p>July 8, 2026</p>",
            "<p>6:30 PM</p>",
            "<p>Studio Hall</p>",
            "</article>",
            "<article>",
            "<h2>Hidden Makers Night</h2>",
            "<p>July 9, 2026</p>",
            "<p>7:00 PM</p>",
            "<p>Community Room</p>",
            "</article>",
            "</main>",
        ].join("");

        const output = buildModelInput(text, html);

        assert.match(output, /Hidden Jazz Workshop/);
        assert.match(output, /July 8, 2026/);
        assert.match(output, /Studio Hall/);
        assert.match(output, /Hidden Makers Night/);
        assert.match(output, /Community Room/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input uses cleaned markdown for html-only fallback", () => {
    const originalDomParser = globalThis.DOMParser;
    globalThis.DOMParser = class {
        parseFromString(html) {
            return new JSDOM(html).window.document;
        }
    };

    try {
        const html = [
            "<html>",
            "<head>",
            "<style>.hidden{display:none}</style>",
            "<script>console.log('tracking')</script>",
            "</head>",
            "<body>",
            "<main>",
            "<h1>Community Market</h1>",
            "<p>June 26, 2026 at 7:00 PM</p>",
            "<p>Main Hall</p>",
            "</main>",
            "</body>",
            "</html>",
        ].join("");

        const output = buildModelInput("", html);

        assert.match(output, /Community Market/);
        assert.match(output, /June 26, 2026/);
        assert.match(output, /Main Hall/);
        assert.doesNotMatch(output, /<main>/);
        assert.doesNotMatch(output, /console\.log/);
        assert.doesNotMatch(output, /\.hidden/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("model input preserves tab delimiters in custom table text", () => {
    const input = [
        "Title\tDate\tTime\tLocation",
        "Community Market\tJune 26, 2026\t7:00 PM\tMain Hall",
        "Open Studio Night\tJune 27, 2026\t6:30 PM\tStudio 4",
    ].join("\n");

    const output = buildModelInput(input, null);

    assert.equal(output, input);
    assert.match(output, /Community Market\tJune 26, 2026\t7:00 PM\tMain Hall/);
});

test("model input preserves csv row newlines in custom table text", () => {
    const input = [
        "Title,Date,Time,Location",
        "Community Market,June 26, 2026,7:00 PM,Main Hall",
        "Open Studio Night,June 27, 2026,6:30 PM,Studio 4",
    ].join("\n");

    const output = buildModelInput(input, null);

    assert.equal(output, input);
    assert.doesNotMatch(output, /Title,Date,Time,Location\n\nCommunity Market/);
});

test("model input preserves markdown table row newlines in custom table text", () => {
    const input = [
        "| Title | Date | Time | Location |",
        "| --- | --- | --- | --- |",
        "| Community Market | June 26, 2026 | 7:00 PM | Main Hall |",
        "| Open Studio Night | June 27, 2026 | 6:30 PM | Studio 4 |",
    ].join("\n");

    const output = buildModelInput(input, null);

    assert.equal(output, input);
    assert.doesNotMatch(output, /\| --- \| --- \| --- \| --- \|\n\n\| Community Market/);
});

test("table csv snippets cap large table context", () => {
    const originalDomParser = globalThis.DOMParser;
    const longCell = "Long event detail ".repeat(40);

    class FakeRow {
        constructor(cells) {
            this.cells = cells.map((textContent) => ({ textContent }));
        }

        querySelectorAll(selector) {
            return selector === "td,th" ? this.cells : [];
        }

        contains(cell) {
            return this.cells.includes(cell);
        }
    }

    class FakeTable {
        constructor(rows) {
            this.rows = rows;
        }

        querySelectorAll(selector) {
            if (selector === "tr") return this.rows;
            if (selector === "thead tr th") return this.rows[0].cells;
            return [];
        }
    }

    globalThis.DOMParser = class {
        parseFromString() {
            const rows = [
                new FakeRow(["Title", "Details"]),
                ...Array.from(
                    { length: 12 },
                    (_, index) => new FakeRow([`Event ${index}`, `${longCell} ${index}`])
                ),
            ];
            const table = new FakeTable(rows);
            return {
                querySelectorAll(selector) {
                    return selector === "table" ? [table] : [];
                },
            };
        }
    };

    try {
        const [csv] = tablesToCsvSnippets("<table></table>", 1, 20, 700);

        assert.ok(csv.length <= 700);
        assert.match(csv, /Event 0/);
        assert.match(csv, /\.\.\./);
        assert.doesNotMatch(csv, /Event 11/);

        const [tinyCsv] = tablesToCsvSnippets("<table></table>", 1, 20, 120);
        assert.ok(tinyCsv.length <= 120);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("table csv snippets keep truncated quoted cells valid", () => {
    const originalDomParser = globalThis.DOMParser;
    const longQuotedCell = `${"A".repeat(236)}" trailing event details that should be truncated`;

    class FakeRow {
        constructor(cells) {
            this.cells = cells.map((textContent) => ({ textContent }));
        }

        querySelectorAll(selector) {
            return selector === "td,th" ? this.cells : [];
        }

        contains(cell) {
            return this.cells.includes(cell);
        }
    }

    class FakeTable {
        constructor(rows) {
            this.rows = rows;
        }

        querySelectorAll(selector) {
            if (selector === "tr") return this.rows;
            if (selector === "thead tr th") return this.rows[0].cells;
            return [];
        }
    }

    globalThis.DOMParser = class {
        parseFromString() {
            const table = new FakeTable([
                new FakeRow(["Title", "Details"]),
                new FakeRow(["Quoted Event", longQuotedCell]),
            ]);
            return {
                querySelectorAll(selector) {
                    return selector === "table" ? [table] : [];
                },
            };
        }
    };

    try {
        const [csv] = tablesToCsvSnippets("<table></table>", 1, 5, 6000);
        const detailCell = csv.split("\n")[1].split(",")[1];

        assert.match(detailCell, /^"(?:[^"]|"")*"$/);
        assert.match(detailCell, /\.\.\."$/);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("table csv snippets clip oversized first rows before adding them", () => {
    const originalDomParser = globalThis.DOMParser;
    const wideQuotedCell = `${'quote "inside" value '.repeat(30)} final event detail`;

    class FakeRow {
        constructor(cells) {
            this.cells = cells.map((textContent) => ({ textContent }));
        }

        querySelectorAll(selector) {
            return selector === "td,th" ? this.cells : [];
        }

        contains(cell) {
            return this.cells.includes(cell);
        }
    }

    class FakeTable {
        constructor(rows) {
            this.rows = rows;
        }

        querySelectorAll(selector) {
            if (selector === "tr") return this.rows;
            if (selector === "thead tr th") return this.rows[0].cells;
            return [];
        }
    }

    globalThis.DOMParser = class {
        parseFromString() {
            const table = new FakeTable([
                new FakeRow(["Title", "Details"]),
                new FakeRow(["Wide Quoted Event", wideQuotedCell]),
            ]);
            return {
                querySelectorAll(selector) {
                    return selector === "table" ? [table] : [];
                },
            };
        }
    };

    try {
        const [csv] = tablesToCsvSnippets("<table></table>", 1, 5, 180);
        const lines = csv.split("\n");

        assert.ok(csv.length <= 180);
        assert.equal(lines.length, 2);
        assert.match(lines[1], /^"(?:[^"]|"")*","(?:[^"]|"")*"$/);
        assert.match(lines[1], /\.\.\./);
    } finally {
        if (originalDomParser === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = originalDomParser;
        }
    }
});

test("popup page scans use compact preprocessing before messaging background", () => {
    const js = fs.readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
    const start = js.indexOf("async function handleScan()");
    assert.notEqual(start, -1, "handleScan should exist");
    const end = js.indexOf("if (!response?.success)", start);
    assert.notEqual(end, -1, "handleScan request setup should be bounded");
    const requestSetup = js.slice(start, end);

    assert.match(js, /import \{ preprocessForPopup \} from "\.\/utils\/scan\.js";/);
    assert.match(
        requestSetup,
        /const \{ modelHtml, csvSnippets \} = preprocessForPopup\(text \|\| "", html \|\| ""\);/
    );
    assert.match(requestSetup, /modelInput:\s*modelHtml/);
    assert.doesNotMatch(requestSetup, /htmlToMarkdown\(html\)/);
});
