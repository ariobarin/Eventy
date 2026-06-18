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

test("google calendar uses all day range for date only events", () => {
    const url = buildCalendarCreateUrl({
        title: "Festival",
        startDate: "2025-10-05",
    });

    assert.equal(getDatesParam(url), "20251005/20251006");
});

test("google calendar treats all day end dates as inclusive", () => {
    const url = buildCalendarCreateUrl({
        title: "Festival",
        startDate: "2025-09-26",
        endDate: "2025-09-28",
    });

    assert.equal(getDatesParam(url), "20250926/20250929");
});
