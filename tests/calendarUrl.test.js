import test from "node:test";
import assert from "node:assert/strict";

import { buildCalendarCreateUrl } from "../src/lib/calendarUrl.js";

function getDatesParam(url) {
    return new URL(url).searchParams.get("dates");
}

test("google calendar defaults missing end time after the start time", () => {
    const url = buildCalendarCreateUrl({
        title: "Breakfast",
        startDate: "2025-10-05",
        startTime: "08:15",
    });

    assert.equal(getDatesParam(url), "20251005T081500/20251005T091500");
});

test("google calendar preserves explicit end time", () => {
    const url = buildCalendarCreateUrl({
        title: "Workshop",
        startDate: "2025-10-05",
        startTime: "08:15",
        endTime: "10:45",
    });

    assert.equal(getDatesParam(url), "20251005T081500/20251005T104500");
});
