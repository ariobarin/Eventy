import test from "node:test";
import assert from "node:assert/strict";

import { generateICS } from "../src/lib/icsGenerator.js";

test("ics uses all day range for date only events", () => {
    const ics = generateICS({
        title: "Festival",
        startDate: "2025-10-05",
    });

    assert.match(ics, /DTSTART;VALUE=DATE:20251005/);
    assert.match(ics, /DTEND;VALUE=DATE:20251006/);
});

test("ics treats all day end dates as inclusive", () => {
    const ics = generateICS({
        title: "Festival",
        startDate: "2025-09-26",
        endDate: "2025-09-28",
    });

    assert.match(ics, /DTSTART;VALUE=DATE:20250926/);
    assert.match(ics, /DTEND;VALUE=DATE:20250929/);
});

test("ics defaults missing end time after start time", () => {
    const ics = generateICS({
        title: "Breakfast",
        startDate: "2025-10-05",
        startTime: "08:15",
    });

    assert.match(ics, /DTSTART:20251005T081500/);
    assert.match(ics, /DTEND:20251005T091500/);
});
