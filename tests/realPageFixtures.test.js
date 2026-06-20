import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    auditRealPageFixture,
    fixtureFileNameForEntry,
    fixturePathForEntry,
    formatAuditLine,
    installNodeDomParser,
    loadRealPageAuditFixtures,
    loadRealPageCorpus,
    mergeCorpusEntryIntoFixture,
} from "../scripts/real-page-fixtures.mjs";

test("real page corpus defines reusable fixture targets", async () => {
    const corpus = await loadRealPageCorpus();

    assert.ok(corpus.length >= 5);
    let eventLabelEntryCount = 0;
    for (const entry of corpus) {
        assert.match(entry.name, /^[a-z0-9-]+$/);
        assert.match(entry.url, /^https:\/\//);
        assert.ok(Array.isArray(entry.expectedAnchors));
        assert.ok(entry.expectedAnchors.length > 0);
        assert.ok(Array.isArray(entry.expectedEvents));
        if (entry.expectedEvents.length) {
            eventLabelEntryCount += 1;
        }
        for (const event of entry.expectedEvents) {
            assert.equal(typeof event.title, "string");
            assert.notEqual(event.title.trim(), "");
            assert.ok(Array.isArray(event.labels));
            assert.ok(event.labels.includes(event.title));
        }
    }
    assert.ok(eventLabelEntryCount >= 3);
});

test("fixture names are stable and file-system safe", () => {
    assert.equal(
        fixtureFileNameForEntry({ name: "Southbank What's On" }),
        "southbank-what-s-on.json"
    );
    assert.equal(
        fixtureFileNameForEntry({ name: "toronto-nathan-phillips" }),
        "toronto-nathan-phillips.json"
    );
});

test("audit output includes previous request baseline ratio", () => {
    const line = formatAuditLine({
        passed: true,
        name: "sample",
        contextChars: 100,
        shrinkRatioVsText: 2,
        shrinkRatioVsMarkdown: 0.5,
        shrinkRatioVsPreviousContext: 0.4,
        missingAnchors: [],
    });

    assert.match(line, /previousRatio=0\.4/);
});

test("real page fixture audit reports retained anchors and size metrics", () => {
    const fixture = {
        name: "sample-event-page",
        url: "https://example.test/events",
        title: "Sample Events",
        lang: "en",
        html: "",
        text: [
            "Navigation item privacy policy subscribe",
            "Opening Night",
            "26 June 2026",
            "7:00 PM",
            "Main Hall",
        ].join("\n\n"),
        expectedAnchors: ["Opening Night", "26 June 2026", "Main Hall"],
    };

    const audit = auditRealPageFixture(fixture);

    assert.equal(audit.name, "sample-event-page");
    assert.equal(audit.missingAnchors.length, 0);
    assert.equal(audit.anchorPresence["Opening Night"], true);
    assert.ok(audit.sourceTextChars > 0);
    assert.ok(audit.modelInputChars > 0);
    assert.ok(audit.contextChars > 0);
    assert.ok(audit.contextChars <= audit.sourceTextChars);
});

test("real page fixture audit reports retained event labels", () => {
    const fixture = {
        name: "sample-event-label-page",
        url: "https://example.test/events",
        title: "Sample Events",
        lang: "en",
        html: "",
        text: [
            "Opening Night",
            "26 June 2026",
            "7:00 PM",
            "Main Hall",
            "Closing Talk",
            "27 June 2026",
        ].join("\n\n"),
        expectedAnchors: ["Opening Night"],
        expectedEvents: [
            {
                title: "Opening Night",
                date: "26 June 2026",
                time: "7:00 PM",
                location: "Main Hall",
            },
            {
                title: "Closing Talk",
                date: "27 June 2026",
                time: "8:00 PM",
                location: "Side Room",
            },
        ],
    };

    const audit = auditRealPageFixture(fixture);

    assert.equal(audit.eventLabelResults.length, 2);
    assert.equal(audit.eventLabelResults[0].passed, true);
    assert.equal(audit.eventLabelResults[0].sourcePassed, true);
    assert.equal(audit.eventLabelResults[0].contextPassed, true);
    assert.deepEqual(audit.eventLabelResults[0].missingLabels, []);
    assert.equal(audit.eventLabelResults[1].passed, false);
    assert.deepEqual(audit.eventLabelResults[1].missingFields, [
        "time",
        "location",
    ]);
    assert.deepEqual(audit.missingEventLabels, [
        "Closing Talk: time=8:00 PM",
        "Closing Talk: location=Side Room",
    ]);
    assert.equal(audit.passed, false);
});

test("real page fixture audit uses current corpus labels over stale snapshots", () => {
    const fixture = {
        name: "sample-stale-snapshot-page",
        url: "https://example.test/old-events",
        title: "Old Events",
        lang: "en",
        html: "",
        text: "Opening Night\n\n26 June 2026\n\nMain Hall",
        expectedAnchors: ["Old Event"],
        expectedEvents: [
            {
                title: "Old Event",
                date: "1 January 2026",
            },
        ],
    };
    const corpusEntry = {
        name: "sample-stale-snapshot-page",
        url: "https://example.test/events",
        expectedAnchors: ["Opening Night"],
        expectedEvents: [
            {
                title: "Opening Night",
                date: "26 June 2026",
                location: "Main Hall",
                labels: ["Opening Night", "26 June 2026", "Main Hall"],
            },
        ],
        maxContextChars: 30000,
        maxPreviousContextGrowthRatio: 1,
    };

    const mergedFixture = mergeCorpusEntryIntoFixture(fixture, corpusEntry);
    const audit = auditRealPageFixture(mergedFixture);

    assert.equal(mergedFixture.url, "https://example.test/events");
    assert.deepEqual(mergedFixture.expectedAnchors, ["Opening Night"]);
    assert.equal(audit.passed, true);
});

test("real page fixture audit requires snapshots for every corpus entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eventy-real-pages-"));
    try {
        const corpusPath = path.join(tempDir, "corpus.json");
        const fixtureDir = path.join(tempDir, "fixtures");
        await fs.mkdir(fixtureDir);
        await fs.writeFile(
            corpusPath,
            JSON.stringify(
                [
                    {
                        name: "captured-page",
                        url: "https://example.test/captured",
                        expectedAnchors: ["Captured Event"],
                    },
                    {
                        name: "missing-page",
                        url: "https://example.test/missing",
                        expectedAnchors: ["Missing Event"],
                    },
                ],
                null,
                2
            )
        );
        await fs.writeFile(
            fixturePathForEntry({ name: "captured-page" }, fixtureDir),
            JSON.stringify({
                name: "captured-page",
                url: "https://example.test/captured",
                html: "",
                text: "Captured Event",
            })
        );

        await assert.rejects(
            () => loadRealPageAuditFixtures(corpusPath, fixtureDir),
            /Missing captured real-page fixtures for missing-page/
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("real page fixture audit rejects snapshots outside the corpus", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eventy-real-pages-"));
    try {
        const corpusPath = path.join(tempDir, "corpus.json");
        const fixtureDir = path.join(tempDir, "fixtures");
        await fs.mkdir(fixtureDir);
        await fs.writeFile(
            corpusPath,
            JSON.stringify(
                [
                    {
                        name: "captured-page",
                        url: "https://example.test/captured",
                        expectedAnchors: ["Captured Event"],
                    },
                ],
                null,
                2
            )
        );
        await fs.writeFile(
            fixturePathForEntry({ name: "captured-page" }, fixtureDir),
            JSON.stringify({
                name: "captured-page",
                url: "https://example.test/captured",
                html: "",
                text: "Captured Event",
            })
        );
        await fs.writeFile(
            fixturePathForEntry({ name: "extra-page" }, fixtureDir),
            JSON.stringify({
                name: "extra-page",
                url: "https://example.test/extra",
                html: "",
                text: "Extra Event",
            })
        );

        await assert.rejects(
            () => loadRealPageAuditFixtures(corpusPath, fixtureDir),
            /Captured real-page fixture extra-page is not defined/
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("real page fixture audit separates source labels from retained context", () => {
    const fixture = {
        name: "sample-hidden-event-page",
        url: "https://example.test/events",
        title: "Sample Events",
        lang: "en",
        html: [
            "<main>",
            "<h1>Opening Night</h1>",
            "<p>26 June 2026</p>",
            "<table><tr><td>8:00 PM</td></tr></table>",
            "</main>",
        ].join(""),
        text: "Opening Night\n\n26 June 2026",
        expectedAnchors: ["Opening Night"],
        expectedEvents: [
            {
                title: "Opening Night",
                date: "26 June 2026",
                time: "8:00 PM",
            },
        ],
    };

    const audit = auditRealPageFixture(fixture);

    assert.equal(audit.eventLabelResults[0].sourcePassed, false);
    assert.deepEqual(audit.eventLabelResults[0].missingSourceFields, ["time"]);
    assert.deepEqual(audit.missingSourceEventLabels, [
        "Opening Night: time=8:00 PM",
    ]);
});

test("real page fixture audit matches event labels across typographic spacing", () => {
    const fixture = {
        name: "sample-event-spacing-page",
        url: "https://example.test/events",
        title: "Sample Events",
        lang: "en",
        html: "",
        text: "Farmers Market\n\n3:00\u202fPM to 7:00 PM\n\nMain Plaza",
        expectedAnchors: ["Farmers Market"],
        expectedEvents: [
            {
                title: "Farmers Market",
                time: "3:00 PM",
                location: "Main Plaza",
            },
        ],
    };

    const audit = auditRealPageFixture(fixture);

    assert.equal(audit.eventLabelResults[0].passed, true);
});

test("real page fixture audit reports markdown baseline shrinkage", async () => {
    const cleanupDomParser = await installNodeDomParser();
    try {
        const fixture = {
            name: "markdown-baseline-page",
            url: "https://example.test/events",
            title: "Markdown Baseline",
            lang: "en",
            html: [
                "<main>",
                "<nav>Privacy Subscribe Account</nav>",
                "<h1>Opening Night</h1>",
                "<p>26 June 2026</p>",
                "<p>Main Hall</p>",
                "</main>",
            ].join(""),
            text: "Opening Night\n\n26 June 2026\n\nMain Hall",
            expectedAnchors: ["Opening Night", "26 June 2026", "Main Hall"],
        };

        const audit = auditRealPageFixture(fixture);

        assert.ok(audit.baselineMarkdownChars > 0);
        assert.ok(audit.previousContextChars > 0);
        assert.ok(audit.shrinkRatioVsMarkdown > 0);
        assert.ok(audit.shrinkRatioVsPreviousContext > 0);
        assert.ok(audit.shrinkRatioVsPreviousContext <= 1);
        assert.ok(audit.shrinkRatioVsMarkdown <= 1);
    } finally {
        cleanupDomParser();
    }
});

test("real page fixture audit allows configured previous context growth", async () => {
    const cleanupDomParser = await installNodeDomParser();
    try {
        const fixture = {
            name: "small-table-growth-page",
            url: "https://example.test/events",
            title: "Small Table Growth",
            lang: "en",
            html: [
                "<main>",
                "<table>",
                "<tr><th>Name</th><th>Date</th><th>Venue</th></tr>",
                "<tr><td>Opening Night</td><td>26 June 2026</td><td>Main Hall</td></tr>",
                "<tr><td>Closing Talk</td><td>27 June 2026</td><td>Side Room</td></tr>",
                "</table>",
                "</main>",
            ].join(""),
            text: [
                "Opening Night",
                "26 June 2026",
                "Main Hall",
                "Closing Talk",
                "27 June 2026",
                "Side Room",
            ].join("\n"),
            expectedAnchors: ["Opening Night"],
            expectedEvents: [
                {
                    title: "Opening Night",
                    date: "26 June 2026",
                    location: "Main Hall",
                },
            ],
            maxPreviousContextGrowthRatio: 1.01,
        };

        const audit = auditRealPageFixture(fixture);

        assert.ok(audit.shrinkRatioVsPreviousContext > 1);
        assert.equal(audit.maxPreviousContextGrowthRatio, 1.01);
        assert.equal(audit.passed, true);
    } finally {
        cleanupDomParser();
    }
});

test("real page fixture audit caps configured previous context growth", () => {
    assert.throws(
        () =>
            auditRealPageFixture({
                name: "wide-growth-page",
                url: "https://example.test/events",
                title: "Wide Growth",
                lang: "en",
                html: "",
                text: "Opening Night",
                expectedAnchors: ["Opening Night"],
                maxPreviousContextGrowthRatio: 1.5,
            }),
        /maxPreviousContextGrowthRatio must be between 1 and 1\.05/
    );
});

test("real page fixture audit records missing anchors", () => {
    const fixture = {
        name: "missing-anchor-page",
        url: "https://example.test/events",
        title: "Missing Anchor",
        lang: "en",
        html: "",
        text: "Opening Night\n\n26 June 2026",
        expectedAnchors: ["Opening Night", "Main Hall"],
    };

    const audit = auditRealPageFixture(fixture);

    assert.deepEqual(audit.missingAnchors, ["Main Hall"]);
    assert.equal(audit.anchorPresence["Opening Night"], true);
    assert.equal(audit.anchorPresence["Main Hall"], false);
});
