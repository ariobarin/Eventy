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
