import test from "node:test";
import assert from "node:assert/strict";

import {
    auditRealPageFixture,
    fixtureFileNameForEntry,
    formatAuditLine,
    installNodeDomParser,
    loadRealPageCorpus,
} from "../scripts/real-page-fixtures.mjs";

test("real page corpus defines reusable fixture targets", async () => {
    const corpus = await loadRealPageCorpus();

    assert.ok(corpus.length >= 5);
    for (const entry of corpus) {
        assert.match(entry.name, /^[a-z0-9-]+$/);
        assert.match(entry.url, /^https:\/\//);
        assert.ok(Array.isArray(entry.expectedAnchors));
        assert.ok(entry.expectedAnchors.length > 0);
    }
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
