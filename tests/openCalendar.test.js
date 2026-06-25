import test from "node:test";
import assert from "node:assert/strict";

function makeEvent(overrides = {}) {
    return {
        title: "Breakfast Meetup",
        startDate: "2026-07-01",
        startTime: "08:00",
        location: "Cafe",
        ...overrides,
    };
}

async function loadOpenCalendarModule({ calendarType = "icloud" } = {}) {
    const originalChrome = globalThis.chrome;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const downloads = [];
    const tabs = [];
    const revokedUrls = [];
    let blobId = 0;

    globalThis.chrome = {
        downloads: {
            onChanged: {
                addListener() {},
            },
            download: async (options) => {
                downloads.push(options);
                return downloads.length;
            },
        },
        storage: {
            sync: {
                get: async () => ({ settings: { defaultCalendar: calendarType } }),
            },
        },
        tabs: {
            create: async (options) => {
                tabs.push(options);
            },
        },
    };

    URL.createObjectURL = () => `blob:eventy-${++blobId}`;
    URL.revokeObjectURL = (url) => {
        revokedUrls.push(url);
    };

    const cacheKey = `${Date.now()}-${Math.random()}`;
    const calendar = await import(`../src/background/openCalendar.js?test=${cacheKey}`);

    return {
        ...calendar,
        downloads,
        tabs,
        revokedUrls,
        restore() {
            if (originalChrome === undefined) {
                delete globalThis.chrome;
            } else {
                globalThis.chrome = originalChrome;
            }
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        },
    };
}

test("iCloud downloads report files to open after download", async () => {
    const env = await loadOpenCalendarModule({ calendarType: "icloud" });

    try {
        const notices = [];

        await env.openCalendarEventsInBackground([makeEvent()], {
            onIcsDownloadStarted: (notice) => {
                notices.push(notice);
            },
        });

        assert.equal(env.downloads.length, 1);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].count, 1);
        assert.equal(notices[0].filenames.length, 1);
        assert.match(notices[0].filenames[0], /\.ics$/);
    } finally {
        env.restore();
    }
});

test("non iCloud calendars open tabs without iCalendar notice", async () => {
    const env = await loadOpenCalendarModule({ calendarType: "google" });

    try {
        const notices = [];

        await env.openCalendarEventsInBackground([makeEvent()], {
            onIcsDownloadStarted: (notice) => {
                notices.push(notice);
            },
        });

        assert.equal(env.tabs.length, 1);
        assert.equal(env.downloads.length, 0);
        assert.deepEqual(notices, []);
    } finally {
        env.restore();
    }
});
