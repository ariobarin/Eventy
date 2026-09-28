import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("popup helper modules expose focused responsibilities", async () => {
    const constants = await import("../src/popup/constants.js");
    const cache = await import("../src/popup/cacheStore.js");
    const dateTime = await import("../src/popup/dateTime.js");
    const eventCards = await import("../src/popup/eventCards.js");
    const scanPolling = await import("../src/popup/scanPolling.js");
    const settings = await import("../src/popup/settingsStore.js");
    const tabCapture = await import("../src/popup/tabCapture.js");
    const toast = await import("../src/popup/toast.js");

    assert.equal(constants.UI_STATE.SCANNING, "scanning");
    assert.equal(cache.makeCacheKey("https://example.test"), "eventy-scan:https://example.test");
    assert.equal(typeof dateTime.formatDateTime, "function");
    assert.equal(typeof dateTime.isEventPast, "function");
    assert.equal(typeof eventCards.createEventCard, "function");
    assert.equal(typeof eventCards.restoreSelection, "function");
    assert.equal(typeof eventCards.scrollToCard, "function");
    assert.equal(typeof scanPolling.createScanPoller, "function");
    assert.equal(typeof scanPolling.createScanPoller().clearForUrl, "function");
    assert.equal(typeof settings.createPopupSettingsStore, "function");
    assert.equal(typeof tabCapture.captureActiveTabHtml, "function");
    assert.equal(typeof toast.showToast, "function");
    assert.equal(typeof toast.hideToast, "function");
});

test("popup date formatting stays behavior compatible", async () => {
    const { formatDateTime } = await import("../src/popup/dateTime.js");

    assert.equal(formatDateTime("2026-06-26", "19:30", "12"), "Jun 26, 2026 7:30 PM");
    assert.equal(formatDateTime("2026-06-26", "19:30", "24"), "Jun 26, 2026 19:30");
    assert.equal(formatDateTime("not-a-date", "19:30", "12"), "not-a-date 19:30");
});

test("event chips show weekdays and month sections keep their own cards", async () => {
    const { createEventCard, renderEventLists } = await import("../src/popup/eventCards.js");
    const dom = new JSDOM('<div id="upcoming"></div><div id="past"></div>');
    const doc = dom.window.document;
    const upcomingEventsListEl = doc.getElementById("upcoming");
    const pastEventsListEl = doc.getElementById("past");
    const events = [
        { title: "October event", startDate: "2026-10-03" },
        { title: "September event", startDate: "2026-09-29" },
        { title: "Past event", startDate: "2026-08-17" },
    ];

    await renderEventLists(events, {
        upcomingEventsListEl,
        pastEventsListEl,
        isEventPast: (event) => event.title === "Past event",
        createCard: (event, idx, color, isPast) => createEventCard(event, idx, {
            doc,
            escapeHtml: (value) => value,
            formatTimeOnly: (value) => value,
            color,
            isPast,
        }),
        updateButtonStates: () => {},
    });

    const upcomingSections = [...upcomingEventsListEl.querySelectorAll(".month-section")];
    assert.equal(upcomingSections.length, 2);
    assert.match(upcomingSections[0].querySelector(".month-section-header").textContent, /September 2026/);
    assert.equal(upcomingSections[0].querySelector(".date-chip-weekday").textContent, "TUE");
    assert.equal(upcomingSections[0].querySelector(".date-chip-day").textContent, "29");
    assert.match(upcomingSections[1].querySelector(".month-section-header").textContent, /October 2026/);
    assert.equal(upcomingSections[1].querySelector(".date-chip-weekday").textContent, "SAT");
    assert.equal(pastEventsListEl.querySelector(".month-section .date-chip-weekday").textContent, "MON");
});

test("popup toast module preserves visible and hidden states", async () => {
    const { showToast, hideToast } = await import("../src/popup/toast.js");
    const dom = new JSDOM(`
        <div id="toast" class="toast hidden">
            <div class="toast-content"></div>
        </div>
    `);

    showToast("Saved", "success", dom.window.document);
    const toast = dom.window.document.getElementById("toast");
    assert.match(toast.textContent, /Saved/);
    assert.ok(toast.classList.contains("visible"));
    assert.ok(toast.classList.contains("toast-success"));

    hideToast(dom.window.document);
    assert.ok(toast.classList.contains("hidden"));
    assert.equal(toast.dataset.timeoutId, undefined);
});

test("popup scan poller completes from fresh URL results", async () => {
    const { createScanPoller } = await import("../src/popup/scanPolling.js");
    const storedEvents = [{ title: "Event" }];
    const storage = {
        async get(keys) {
            assert.deepEqual(keys, [
                "eventy-scan:https://example.test",
                "eventy-scanning:https://example.test",
            ]);
            return {
                "eventy-scan:https://example.test": {
                    events: storedEvents,
                    ts: Date.now(),
                },
                "eventy-scanning:https://example.test": {
                    startTime: Date.now() - 10,
                },
            };
        },
        async remove() {
            throw new Error("remove should not be called for URL completion");
        },
    };
    const timeoutIds = [];
    const poller = createScanPoller({
        storage,
        setTimeoutFn: (fn) => {
            timeoutIds.push(fn);
            return timeoutIds.length;
        },
    });

    let completed = null;
    poller.pollForResults(
        "https://example.test",
        null,
        (result) => {
            completed = result;
        },
        () => {
            throw new Error("poll should not fail");
        },
        { minimumResultTs: Date.now() - 1000 }
    );

    assert.equal(timeoutIds.length, 1);
    await timeoutIds[0]();
    assert.deepEqual(completed.events, storedEvents);
});
