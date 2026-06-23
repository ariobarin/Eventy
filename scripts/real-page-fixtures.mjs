import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    htmlToMarkdown,
    MODEL_INPUT_MAX_CHARS,
} from "../src/llm/preprocess.js";
import { preprocessForPopup } from "../src/utils/scan.js";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVENT_LABEL_FIELDS = ["title", "date", "time", "location"];

export const REAL_PAGE_CORPUS_PATH = path.join(
    ROOT_DIR,
    "tests",
    "real-pages",
    "corpus.json"
);
export const REAL_PAGE_FIXTURE_DIR = path.join(
    ROOT_DIR,
    "tests",
    "fixtures",
    "real-pages"
);
const GENERATED_REAL_PAGE_REPORT_FILE_PATTERN =
    /^(?:report|llm-report|old-new-llm-report)(?:-[^.]+)?\.json$/;

export function fixtureFileNameForEntry(entry) {
    const safeName = String(entry?.name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (!safeName) {
        throw new Error("Real page corpus entry is missing a usable name.");
    }

    return `${safeName}.json`;
}

export function fixturePathForEntry(entry, fixtureDir = REAL_PAGE_FIXTURE_DIR) {
    return path.join(fixtureDir, fixtureFileNameForEntry(entry));
}

function normalizeCorpusEntry(entry) {
    const expectedAnchors = entry.expectedAnchors || entry.anchors || [];
    const expectedEvents = Array.isArray(entry.expectedEvents)
        ? entry.expectedEvents.map(normalizeExpectedEvent)
        : [];
    return {
        ...entry,
        name: String(entry.name || "").trim(),
        url: String(entry.url || "").trim(),
        expectedAnchors: expectedAnchors.map((anchor) => String(anchor)),
        expectedEvents,
        maxContextChars:
            Number.isFinite(entry.maxContextChars) && entry.maxContextChars > 0
                ? entry.maxContextChars
                : MODEL_INPUT_MAX_CHARS,
        maxPreviousContextGrowthRatio:
            Number.isFinite(entry.maxPreviousContextGrowthRatio) &&
            entry.maxPreviousContextGrowthRatio > 0
                ? entry.maxPreviousContextGrowthRatio
                : null,
    };
}

function normalizeExpectedEvent(event) {
    const normalized = {};
    for (const field of EVENT_LABEL_FIELDS) {
        const value = String(event?.[field] || "").trim();
        if (value) normalized[field] = value;
    }

    const labels = [
        ...EVENT_LABEL_FIELDS.map((field) => normalized[field]),
        ...(Array.isArray(event?.labels) ? event.labels : []),
    ]
        .map((label) => String(label || "").trim())
        .filter(Boolean);

    return {
        ...event,
        ...normalized,
        labels: [...new Set(labels)],
    };
}

function normalizeSearchText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u2018\u2019\u201b]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/([(/])\s+/g, "$1")
        .replace(/\s+([)/])/g, "$1")
        .replace(/\s*-\s*/g, "-")
        .trim()
        .toLowerCase();
}

function contextIncludes(combinedContext, label) {
    return normalizeSearchText(combinedContext).includes(normalizeSearchText(label));
}

function contextSeparatorChars(csvSnippets) {
    return csvSnippets.length;
}

export async function loadRealPageCorpus(corpusPath = REAL_PAGE_CORPUS_PATH) {
    const raw = await fs.readFile(corpusPath, "utf8");
    const corpus = JSON.parse(raw);
    if (!Array.isArray(corpus)) {
        throw new Error("Real page corpus must be a JSON array.");
    }

    return corpus.map(normalizeCorpusEntry);
}

export async function loadCapturedRealPageFixtures(
    fixtureDir = REAL_PAGE_FIXTURE_DIR
) {
    const entries = await fs.readdir(fixtureDir, { withFileTypes: true }).catch(
        (error) => {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    );

    const fixtures = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        if (GENERATED_REAL_PAGE_REPORT_FILE_PATTERN.test(entry.name)) continue;

        const raw = await fs.readFile(path.join(fixtureDir, entry.name), "utf8");
        fixtures.push(JSON.parse(raw));
    }

    fixtures.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return fixtures;
}

export function mergeCorpusEntryIntoFixture(fixture, corpusEntry) {
    return {
        ...fixture,
        ...corpusEntry,
        html: fixture.html,
        text: fixture.text,
        title: fixture.title,
        lang: fixture.lang,
        finalUrl: fixture.finalUrl,
        capturedAt: fixture.capturedAt,
    };
}

export async function loadRealPageAuditFixtures(
    corpusPath = REAL_PAGE_CORPUS_PATH,
    fixtureDir = REAL_PAGE_FIXTURE_DIR,
    { names = [] } = {}
) {
    const corpus = await loadRealPageCorpus(corpusPath);
    const corpusByName = new Map(corpus.map((entry) => [entry.name, entry]));
    const wantedNames = new Set(names.map((name) => String(name || "").trim()));
    const requiredCorpus = wantedNames.size
        ? corpus.filter((entry) => wantedNames.has(entry.name))
        : corpus;
    if (wantedNames.size && requiredCorpus.length !== wantedNames.size) {
        const foundNames = new Set(requiredCorpus.map((entry) => entry.name));
        const missingNames = [...wantedNames].filter((name) => !foundNames.has(name));
        throw new Error(
            `No real-page corpus entries matched ${missingNames.join(", ")}.`
        );
    }
    const requiredCorpusByName = new Map(
        requiredCorpus.map((entry) => [entry.name, entry])
    );
    const fixtures = await loadCapturedRealPageFixtures(fixtureDir);
    const fixtureNames = new Set(
        fixtures.map((fixture) => String(fixture.name || "").trim())
    );
    const missingFixtureNames = requiredCorpus
        .map((entry) => entry.name)
        .filter((name) => !fixtureNames.has(name));
    if (missingFixtureNames.length) {
        throw new Error(
            `Missing captured real-page fixtures for ${missingFixtureNames.join(
                ", "
            )}. Run npm run capture:real-pages.`
        );
    }

    return fixtures.flatMap((fixture) => {
        const corpusEntry = corpusByName.get(String(fixture.name || "").trim());
        if (!corpusEntry) {
            throw new Error(
                `Captured real-page fixture ${fixture.name} is not defined in tests/real-pages/corpus.json.`
            );
        }
        if (wantedNames.size && !requiredCorpusByName.has(corpusEntry.name)) {
            return [];
        }
        return [mergeCorpusEntryIntoFixture(fixture, corpusEntry)];
    });
}

export async function installNodeDomParser() {
    if (typeof globalThis.DOMParser !== "undefined") {
        return () => {};
    }

    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    globalThis.DOMParser = dom.window.DOMParser;

    return () => {
        delete globalThis.DOMParser;
        dom.window.close();
    };
}

export function auditRealPageFixture(fixture) {
    const text = String(fixture.text || "");
    const html = String(fixture.html || "");
    const { modelHtml, csvSnippets } = preprocessForPopup(text, html);
    const baselineMarkdown =
        html && typeof globalThis.DOMParser !== "undefined"
            ? htmlToMarkdown(html)
            : "";
    const csvChars = csvSnippets.reduce((sum, csv) => sum + csv.length, 0);
    const separatorChars = contextSeparatorChars(csvSnippets);
    const contextChars = modelHtml.length + csvChars + separatorChars;
    const previousContextChars = baselineMarkdown.length
        ? baselineMarkdown.length + csvChars + separatorChars
        : null;
    const combinedContext = [modelHtml, ...csvSnippets].join("\n");
    const expectedAnchors = (fixture.expectedAnchors || fixture.anchors || []).map(
        (anchor) => String(anchor)
    );
    const anchorPresence = Object.fromEntries(
        expectedAnchors.map((anchor) => [anchor, contextIncludes(combinedContext, anchor)])
    );
    const missingAnchors = expectedAnchors.filter(
        (anchor) => !anchorPresence[anchor]
    );
    const maxContextChars =
        Number.isFinite(fixture.maxContextChars) && fixture.maxContextChars > 0
            ? fixture.maxContextChars
            : MODEL_INPUT_MAX_CHARS;
    const maxPreviousContextGrowthRatio =
        Number.isFinite(fixture.maxPreviousContextGrowthRatio) &&
        fixture.maxPreviousContextGrowthRatio > 0
            ? fixture.maxPreviousContextGrowthRatio
            : null;
    const shrinkRatioVsPreviousContext = previousContextChars
        ? Number((contextChars / previousContextChars).toFixed(4))
        : null;
    const previousContextGrowthPassed =
        maxPreviousContextGrowthRatio === null ||
        shrinkRatioVsPreviousContext === null ||
        shrinkRatioVsPreviousContext <= maxPreviousContextGrowthRatio;
    const expectedEvents = Array.isArray(fixture.expectedEvents)
        ? fixture.expectedEvents.map(normalizeExpectedEvent)
        : [];
    const eventLabelResults = expectedEvents.map((event, index) =>
        auditExpectedEventLabels(event, index, text, combinedContext)
    );
    const missingEventLabels = eventLabelResults.flatMap((event) =>
        event.missingLabels.map(
            (missing) => `${event.title}: ${missing.field}=${missing.label}`
        )
    );
    const missingSourceEventLabels = eventLabelResults.flatMap((event) =>
        event.missingSourceLabels.map(
            (missing) => `${event.title}: ${missing.field}=${missing.label}`
        )
    );

    return {
        name: fixture.name,
        url: fixture.url,
        finalUrl: fixture.finalUrl,
        title: fixture.title,
        capturedAt: fixture.capturedAt,
        sourceHtmlChars: html.length,
        sourceTextChars: text.length,
        baselineMarkdownChars: baselineMarkdown.length || null,
        previousContextChars,
        modelInputChars: modelHtml.length,
        csvSnippetCount: csvSnippets.length,
        csvChars,
        separatorChars,
        contextChars,
        shrinkRatioVsText: text.length
            ? Number((contextChars / text.length).toFixed(4))
            : null,
        shrinkRatioVsMarkdown: baselineMarkdown.length
            ? Number((contextChars / baselineMarkdown.length).toFixed(4))
            : null,
        shrinkRatioVsPreviousContext,
        maxContextChars,
        maxPreviousContextGrowthRatio,
        anchorPresence,
        missingAnchors,
        eventLabelResults,
        missingSourceEventLabels,
        missingEventLabels,
        passed:
            missingAnchors.length === 0 &&
            missingSourceEventLabels.length === 0 &&
            missingEventLabels.length === 0 &&
            contextChars <= maxContextChars &&
            previousContextGrowthPassed,
    };
}

function auditExpectedEventLabels(event, index, sourceContext, combinedContext) {
    const title = event.title || `event-${index + 1}`;
    const fieldLabels = EVENT_LABEL_FIELDS.map((field) => ({
        field,
        label: String(event[field] || "").trim(),
    })).filter((label) => label.label);
    const sourceLabelPresence = Object.fromEntries(
        fieldLabels.map(({ field, label }) => [
            field,
            contextIncludes(sourceContext, label),
        ])
    );
    const contextLabelPresence = Object.fromEntries(
        fieldLabels.map(({ field, label }) => [
            field,
            contextIncludes(combinedContext, label),
        ])
    );
    const missingSourceLabels = fieldLabels.filter(
        ({ field }) => !sourceLabelPresence[field]
    );
    const missingContextLabels = fieldLabels.filter(
        ({ field }) => !contextLabelPresence[field]
    );

    return {
        index,
        title,
        labels: fieldLabels,
        sourceLabelPresence,
        contextLabelPresence,
        labelPresence: contextLabelPresence,
        missingSourceFields: missingSourceLabels.map(({ field }) => field),
        missingContextFields: missingContextLabels.map(({ field }) => field),
        missingFields: missingContextLabels.map(({ field }) => field),
        missingSourceLabels,
        missingContextLabels,
        missingLabels: missingContextLabels,
        sourcePassed: missingSourceLabels.length === 0,
        contextPassed: missingContextLabels.length === 0,
        passed:
            missingSourceLabels.length === 0 &&
            missingContextLabels.length === 0,
    };
}

export function auditRealPageFixtures(fixtures) {
    const pages = fixtures.map(auditRealPageFixture);
    return {
        generatedAt: new Date().toISOString(),
        pageCount: pages.length,
        passed: pages.every((page) => page.passed),
        pages,
    };
}

export function formatAuditLine(page) {
    const status = page.passed ? "PASS" : "FAIL";
    const textRatio =
        page.shrinkRatioVsText === null ? "n/a" : String(page.shrinkRatioVsText);
    const markdownRatio =
        page.shrinkRatioVsMarkdown === null
            ? "n/a"
            : String(page.shrinkRatioVsMarkdown);
    const previousRatio =
        page.shrinkRatioVsPreviousContext === null
            ? "n/a"
            : String(page.shrinkRatioVsPreviousContext);
    const missing = page.missingAnchors.length
        ? ` missing=${page.missingAnchors.join(" | ")}`
        : "";
    const missingEvents = page.missingEventLabels?.length
        ? ` missingEvents=${page.missingEventLabels.join(" | ")}`
        : "";
    const missingSourceEvents = page.missingSourceEventLabels?.length
        ? ` missingSourceEvents=${page.missingSourceEventLabels.join(" | ")}`
        : "";

    return `${status} ${page.name} context=${page.contextChars} textRatio=${textRatio} markdownRatio=${markdownRatio} previousRatio=${previousRatio}${missing}${missingSourceEvents}${missingEvents}`;
}

export function findChromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(
            process.env.LOCALAPPDATA || "",
            "Google",
            "Chrome",
            "Application",
            "chrome.exe"
        ),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
    ].filter(Boolean);

    return candidates.find((candidate) => {
        try {
            fsSync.accessSync(candidate);
            return true;
        } catch {
            return false;
        }
    });
}
