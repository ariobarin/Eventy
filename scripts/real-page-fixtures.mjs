import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { htmlToMarkdown } from "../src/llm/preprocess.js";
import { preprocessForPopup } from "../src/utils/scan.js";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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
    return {
        ...entry,
        name: String(entry.name || "").trim(),
        url: String(entry.url || "").trim(),
        expectedAnchors: expectedAnchors.map((anchor) => String(anchor)),
        maxContextChars:
            Number.isFinite(entry.maxContextChars) && entry.maxContextChars > 0
                ? entry.maxContextChars
                : 30000,
    };
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
        if (entry.name === "report.json") continue;

        const raw = await fs.readFile(path.join(fixtureDir, entry.name), "utf8");
        fixtures.push(JSON.parse(raw));
    }

    fixtures.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return fixtures;
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
    const contextChars = modelHtml.length + csvChars;
    const previousContextChars = baselineMarkdown.length
        ? baselineMarkdown.length + csvChars
        : null;
    const combinedContext = [modelHtml, ...csvSnippets].join("\n");
    const expectedAnchors = (fixture.expectedAnchors || fixture.anchors || []).map(
        (anchor) => String(anchor)
    );
    const anchorPresence = Object.fromEntries(
        expectedAnchors.map((anchor) => [anchor, combinedContext.includes(anchor)])
    );
    const missingAnchors = expectedAnchors.filter(
        (anchor) => !anchorPresence[anchor]
    );
    const maxContextChars =
        Number.isFinite(fixture.maxContextChars) && fixture.maxContextChars > 0
            ? fixture.maxContextChars
            : 30000;

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
        contextChars,
        shrinkRatioVsText: text.length
            ? Number((contextChars / text.length).toFixed(4))
            : null,
        shrinkRatioVsMarkdown: baselineMarkdown.length
            ? Number((contextChars / baselineMarkdown.length).toFixed(4))
            : null,
        shrinkRatioVsPreviousContext: previousContextChars
            ? Number((contextChars / previousContextChars).toFixed(4))
            : null,
        maxContextChars,
        anchorPresence,
        missingAnchors,
        passed:
            missingAnchors.length === 0 &&
            contextChars <= maxContextChars &&
            (!previousContextChars || contextChars <= previousContextChars),
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

    return `${status} ${page.name} context=${page.contextChars} textRatio=${textRatio} markdownRatio=${markdownRatio} previousRatio=${previousRatio}${missing}`;
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
