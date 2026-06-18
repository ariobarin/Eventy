import test from "node:test";
import assert from "node:assert/strict";

import { extractTimezone } from "../src/utils/timezone.js";

test("timezone extraction recognizes generic US aliases", () => {
    assert.deepEqual(extractTimezone("2:00 PM ET"), {
        timezone: "America/New_York",
        cleanTime: "2:00 PM",
    });
    assert.deepEqual(extractTimezone("11:30 AM PT"), {
        timezone: "America/Los_Angeles",
        cleanTime: "11:30 AM",
    });
    assert.deepEqual(extractTimezone("14:00 CT"), {
        timezone: "America/Chicago",
        cleanTime: "14:00",
    });
    assert.deepEqual(extractTimezone("9:15 PM MT"), {
        timezone: "America/Denver",
        cleanTime: "9:15 PM",
    });
});
