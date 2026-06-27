import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findChromeExecutable } from "./real-page-fixtures.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_REPORT_DIR = path.join(ROOT_DIR, "tests", "fixtures", "ui");
const POPUP_PATH = "/src/ui/index.html";
const SETTINGS_PATH = "/src/ui/settings.html";

const options = parseArgs(process.argv.slice(2));

function parseArgs(args) {
    const parsed = {
        headless: process.env.EVENTY_UI_HEADLESS === "1",
        keepBrowser: process.env.EVENTY_UI_KEEP_BROWSER === "1",
        mockDelayMs: Number(process.env.EVENTY_UI_MOCK_DELAY_MS || 250),
        reportDir: process.env.EVENTY_UI_REPORT_DIR || DEFAULT_REPORT_DIR,
        timeoutMs: Number(process.env.EVENTY_UI_TIMEOUT_MS || 30000),
    };

    for (const arg of args) {
        if (arg === "--headless") parsed.headless = true;
        else if (arg === "--headful") parsed.headless = false;
        else if (arg === "--keep-browser") parsed.keepBrowser = true;
        else if (arg.startsWith("--mock-delay-ms=")) {
            parsed.mockDelayMs = Number(arg.slice("--mock-delay-ms=".length));
        } else if (arg.startsWith("--report-dir=")) {
            parsed.reportDir = path.resolve(arg.slice("--report-dir=".length));
        } else if (arg.startsWith("--timeout-ms=")) {
            parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
        }
    }

    if (!Number.isFinite(parsed.mockDelayMs) || parsed.mockDelayMs < 0) {
        throw new Error("mock delay must be a non-negative number.");
    }
    if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error("timeout must be a positive number.");
    }

    return parsed;
}

async function importPuppeteer() {
    try {
        return await import("puppeteer-core");
    } catch (error) {
        throw new Error("Missing puppeteer-core. Run npm install before UI verification.", {
            cause: error,
        });
    }
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function copyExtensionToTemp(mockDelayMs) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eventy-ui-"));
    const extensionDir = path.join(tempRoot, "extension");
    await fs.mkdir(extensionDir, { recursive: true });

    const excludedNames = new Set([
        ".git",
        ".wrangler",
        "coverage",
        "dist",
        "node_modules",
        "tmp",
    ]);

    await fs.cp(ROOT_DIR, extensionDir, {
        recursive: true,
        filter: (source) => {
            const relative = path.relative(ROOT_DIR, source);
            if (!relative) return true;
            const firstSegment = relative.split(path.sep)[0];
            if (excludedNames.has(firstSegment)) return false;
            if (relative.startsWith(path.join("tests", "fixtures"))) return false;
            return true;
        },
    });

    const configPath = path.join(extensionDir, "config.js");
    const originalConfig = await fs.readFile(configPath, "utf8");
    const testConfig = originalConfig
        .replace(/export const DEBUG = .*?;/, "export const DEBUG = false;")
        .replace(/export const MOCK_MODE = .*?;/, "export const MOCK_MODE = true;")
        .replace(
            /export const MOCK_DELAY_MS = .*?;/,
            `export const MOCK_DELAY_MS = ${Math.floor(mockDelayMs)};`
        );
    await fs.writeFile(configPath, testConfig);

    return { tempRoot, extensionDir };
}

async function startFixtureServer() {
    const pages = new Map([
        [
            "/event-page.html",
            `<!doctype html>
            <html lang="en">
            <head><title>Eventy UI Fixture</title></head>
            <body>
                <main>
                    <h1>Community Arts Calendar</h1>
                    <article>
                        <h2>Lantern Walk</h2>
                        <p>Friday, October 3, 2026 from 7:00 PM to 9:00 PM.</p>
                        <p>Meet at Harbourfront Centre, Toronto.</p>
                    </article>
                    <article>
                        <h2>Studio Open House</h2>
                        <p>Saturday, October 4, 2026 at 1:30 PM.</p>
                        <p>Location: 45 King Street West.</p>
                    </article>
                </main>
            </body>
            </html>`,
        ],
        [
            "/empty-page.html",
            `<!doctype html>
            <html lang="en">
            <head><title>Plain Fixture</title></head>
            <body><main><h1>Plain page</h1><p>No special app APIs here.</p></main></body>
            </html>`,
        ],
    ]);

    const server = http.createServer((request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        const body = pages.get(url.pathname);
        if (!body) {
            response.writeHead(404, { "content-type": "text/plain" });
            response.end("not found");
            return;
        }
        response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
        });
        response.end(body);
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function getExtensionServiceWorker(browser, extensionDir) {
    const target = await browser.waitForTarget(
        (candidate) =>
            candidate.type() === "service_worker" &&
            candidate.url().includes("/src/background.js"),
        { timeout: options.timeoutMs }
    );
    const worker = await target.worker();
    if (!worker) throw new Error(`Extension service worker did not load from ${extensionDir}.`);

    const extensionId = new URL(target.url()).host;
    const extensions = await browser.extensions();
    const extension = extensions.get(extensionId);
    if (!extension) {
        throw new Error(`Loaded extension ${extensionId} was not available through browser.extensions().`);
    }
    return { worker, extensionId, extension };
}

async function clearExtensionStorage(browser, extensionId) {
    const page = await browser.newPage();
    try {
        await page.goto(`chrome-extension://${extensionId}${POPUP_PATH}`, {
            waitUntil: "domcontentloaded",
        });
        await page.evaluate(async () => {
            await chrome.storage.local.clear();
            await chrome.storage.sync.clear();
        });
    } finally {
        await closePage(page);
    }
}

async function openExtensionPopup(browser, activePage, extensionId, extension) {
    await activePage.bringToFront();
    const popupUrlPrefix = `chrome-extension://${extensionId}${POPUP_PATH}`;

    const popupTargetPromise = browser.waitForTarget(
        (target) => target.type() === "page" && target.url().startsWith(popupUrlPrefix),
        { timeout: options.timeoutMs }
    );

    if (typeof activePage.triggerExtensionAction !== "function") {
        throw new Error("This Puppeteer version does not expose page.triggerExtensionAction().");
    }

    await activePage.triggerExtensionAction(extension);
    const popupTarget = await popupTargetPromise;
    const popup = await popupTarget.asPage();
    if (!popup) throw new Error("Extension popup page target was not available.");
    await popup.bringToFront();
    await popup.waitForSelector("#scanBtn", { timeout: options.timeoutMs });
    await popup.waitForFunction(() => !document.body.classList.contains("theme-loading"), {
        timeout: options.timeoutMs,
    }).catch(() => {});
    return popup;
}

async function waitForScanAvailability(popup) {
    await popup.waitForFunction(
        () => {
            const button = document.getElementById("scanBtn");
            return button && button.title !== "Checking page scan availability.";
        },
        { timeout: options.timeoutMs }
    );
}

async function waitForEventCards(popup) {
    await popup.waitForFunction(
        () => document.querySelectorAll(".event-card").length > 0,
        { timeout: options.timeoutMs }
    );
}

async function waitForVisibleResults(popup) {
    await waitForEventCards(popup);
    await popup.waitForFunction(
        () => document.getElementById("results")?.classList.contains("has-results"),
        { timeout: options.timeoutMs }
    );
    await popup.waitForFunction(
        () => {
            const card = document.querySelector(".event-card");
            if (!card) return false;
            card.scrollIntoView({ block: "nearest", inline: "nearest" });
            const rect = card.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const element = document.elementFromPoint(centerX, centerY);
            return Boolean(
                rect.width > 0 &&
                rect.height > 0 &&
                centerY >= 0 &&
                centerY <= document.documentElement.clientHeight &&
                element &&
                (element === card || card.contains(element))
            );
        },
        { timeout: options.timeoutMs }
    );
    await popup.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
}

async function attachPageDiagnostics(page, name) {
    const diagnostics = {
        name,
        consoleErrors: [],
        pageErrors: [],
    };

    page.on("console", (message) => {
        if (message.type() === "error") {
            diagnostics.consoleErrors.push(message.text());
        }
    });
    page.on("pageerror", (error) => {
        diagnostics.pageErrors.push(error.message);
    });

    return diagnostics;
}

async function collectPopupState(popup) {
    return await popup.evaluate(() => {
        const rectOf = (element) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            };
        };
        const button = document.getElementById("scanBtn");
        const scanSection = document.getElementById("scanSection");
        const toast = document.getElementById("toast");
        const customSection = document.getElementById("customContextSection");
        const customInput = document.getElementById("customInput");
        const addSelected = document.getElementById("addSelectedBtn");
        const results = document.getElementById("results");
        const firstCard = document.querySelector(".event-card");
        const firstCardRect = rectOf(firstCard);
        const firstCardCenter = firstCardRect
            ? {
                x: firstCardRect.x + firstCardRect.width / 2,
                y: firstCardRect.y + firstCardRect.height / 2,
            }
            : null;
        const elementAtFirstCardCenter = firstCardCenter
            ? document.elementFromPoint(firstCardCenter.x, firstCardCenter.y)
            : null;
        const overflowElements = Array.from(
            document.querySelectorAll(
                "button, .event-title, .event-location, .event-time, .section-title, textarea"
            )
        )
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map((element) => ({
                tag: element.tagName.toLowerCase(),
                id: element.id || "",
                className: String(element.className || ""),
                text: (element.textContent || "").trim().slice(0, 80),
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
            }));

        return {
            body: {
                scrollWidth: document.body.scrollWidth,
                clientWidth: document.body.clientWidth,
                scrollHeight: document.body.scrollHeight,
                clientHeight: document.body.clientHeight,
                text: document.body.innerText,
            },
            scanButton: button
                ? {
                    disabled: button.disabled,
                    title: button.title,
                    text: button.innerText.trim(),
                    className: button.className,
                    rect: rectOf(button),
                }
                : null,
            scanSection: scanSection
                ? {
                    title: scanSection.title,
                    className: scanSection.className,
                    rect: rectOf(scanSection),
                    hidden: scanSection.classList.contains("hidden"),
                }
                : null,
            toast: toast
                ? {
                    className: toast.className,
                    text: toast.innerText.trim(),
                    hidden: toast.classList.contains("hidden"),
                    visible: toast.classList.contains("visible"),
                    rect: rectOf(toast),
                }
                : null,
            customContext: customSection
                ? {
                    hidden: customSection.classList.contains("hidden"),
                    textareaValue: customInput?.value || "",
                    scanMediaDisabled: document.getElementById("scanMediaBtn")?.disabled || false,
                    rect: rectOf(customSection),
                }
                : null,
            results: results
                ? {
                    className: results.className,
                    rect: rectOf(results),
                    computed: {
                        display: getComputedStyle(results).display,
                        overflowY: getComputedStyle(results).overflowY,
                        maxHeight: getComputedStyle(results).maxHeight,
                    },
                    eventCards: document.querySelectorAll(".event-card").length,
                    skeletonCards: document.querySelectorAll(".skeleton-card").length,
                    upcomingCards: document.querySelectorAll("#upcomingEventsList .event-card").length,
                    pastCards: document.querySelectorAll("#pastEventsList .event-card").length,
                    selectedCards: document.querySelectorAll(".event-card.selected").length,
                    quotaVisible: !document.getElementById("quotaExceeded")?.classList.contains("hidden"),
                    firstCard: firstCard
                        ? {
                            rect: firstCardRect,
                            text: firstCard.innerText.trim().slice(0, 160),
                            visibleAtCenter: Boolean(
                                elementAtFirstCardCenter &&
                                (elementAtFirstCardCenter === firstCard ||
                                    firstCard.contains(elementAtFirstCardCenter))
                            ),
                            elementAtCenter: elementAtFirstCardCenter
                                ? {
                                    tag: elementAtFirstCardCenter.tagName.toLowerCase(),
                                    className: String(elementAtFirstCardCenter.className || ""),
                                    text: (elementAtFirstCardCenter.textContent || "").trim().slice(0, 80),
                                }
                                : null,
                        }
                        : null,
                }
                : null,
            addSelected: addSelected
                ? {
                    disabled: addSelected.disabled,
                    text: addSelected.innerText.trim(),
                }
                : null,
            overflowElements,
        };
    });
}

async function captureEvidence(popup, reportDir, name) {
    const safeName = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const screenshotPath = path.join(reportDir, `${safeName}.png`);
    const state = await collectPopupState(popup);
    await popup.setViewport({
        width: Math.max(320, state.body.scrollWidth + 2),
        height: Math.max(114, state.body.scrollHeight + 2),
    }).catch(() => {});
    await popup.screenshot({ path: screenshotPath, fullPage: true });
    return {
        screenshot: path.relative(ROOT_DIR, screenshotPath),
        state,
    };
}

function assertNoPopupOverflow(state) {
    const blocking = state.overflowElements.filter((element) => {
        if (element.tag === "textarea") return false;
        return true;
    });
    assert.deepEqual(blocking, [], "popup should not have horizontally overflowing controls or labels");
}

function assertFirstCardVisible(state, label) {
    if (state.results.firstCard?.visibleAtCenter === true) return;
    throw new assert.AssertionError({
        message: `${label} first result card should be visible in the popup`,
        actual: state.results.firstCard,
        expected: {
            visibleAtCenter: true,
            body: {
                clientHeight: state.body.clientHeight,
                scrollHeight: state.body.scrollHeight,
            },
            results: {
                rect: state.results.rect,
                className: state.results.className,
                computed: state.results.computed,
            },
        },
        operator: "visibleAtCenter",
    });
}

function assertNoUnexpectedErrors(diagnostics) {
    const ignoredConsoleErrors = diagnostics.consoleErrors.filter((message) => {
        const normalized = message.toLowerCase();
        return !normalized.includes("failed to load resource");
    });

    assert.deepEqual(diagnostics.pageErrors, [], "page should not throw runtime errors");
    assert.deepEqual(ignoredConsoleErrors, [], "page should not log console errors");
}

async function runCase(results, name, fn) {
    const startedAt = Date.now();
    try {
        const evidence = await fn();
        results.push({
            name,
            status: "passed",
            durationMs: Date.now() - startedAt,
            ...evidence,
        });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({
            name,
            status: "failed",
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message,
            actual: error.actual,
            expected: error.expected,
        });
        console.error(`FAIL ${name}`);
        console.error(error.stack || error.message);
        throw error;
    }
}

async function closePage(page) {
    await page?.close().catch(() => {});
}

async function closeBrowser(browser) {
    const closed = await Promise.race([
        browser.close().then(() => true).catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
    ]);

    if (closed) return;

    const browserProcess = typeof browser.process === "function"
        ? browser.process()
        : null;
    if (browserProcess && !browserProcess.killed) {
        browserProcess.kill();
    }
}

async function closeServer(serverHandle) {
    await Promise.race([
        serverHandle.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
}

async function removeTempRoot(tempRoot) {
    if (!await pathExists(tempRoot)) return;

    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    console.warn(`warning: could not remove temporary browser profile: ${lastError?.message}`);
}

async function writeReport(reportDir, report) {
    const reportPath = path.join(reportDir, "report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`report ${path.relative(ROOT_DIR, reportPath)}`);
}

async function main() {
    const chromePath = findChromeExecutable();
    if (!chromePath) {
        throw new Error("Chrome was not found. Set CHROME_PATH and retry.");
    }

    const { default: puppeteer } = await importPuppeteer();
    const reportDir = path.resolve(options.reportDir);
    await fs.rm(reportDir, { recursive: true, force: true });
    await fs.mkdir(reportDir, { recursive: true });

    const fixtureServer = await startFixtureServer();
    const { tempRoot, extensionDir } = await copyExtensionToTemp(options.mockDelayMs);
    const userDataDir = path.join(tempRoot, "profile");
    const results = [];
    let browser = null;

    try {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: options.headless ? "new" : false,
            pipe: true,
            enableExtensions: [extensionDir],
            defaultViewport: { width: 1200, height: 900 },
            userDataDir,
            args: [
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-features=Translate,OptimizationHints",
                "--window-size=1200,900",
            ],
        });

        const { extensionId, extension } = await getExtensionServiceWorker(browser, extensionDir);

        await runCase(results, "protected page disables scan", async () => {
            await clearExtensionStorage(browser, extensionId);
            const page = await browser.newPage();
            const diagnostics = await attachPageDiagnostics(page, "protected-active-page");
            await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
            const popup = await openExtensionPopup(browser, page, extensionId, extension);
            const popupDiagnostics = await attachPageDiagnostics(popup, "protected-popup");
            await waitForScanAvailability(popup);

            const before = await captureEvidence(popup, reportDir, "protected-page-before");
            assert.equal(before.state.scanButton.disabled, true);
            assert.equal(before.state.scanButton.title, "Chrome pages cannot be scanned.");
            assert.match(before.state.scanSection.className, /\bscan-unavailable\b/);
            assert.equal(before.state.toast.hidden, true);
            assert.equal(before.state.results.eventCards, 0);

            await popup.click("#scanBtn").catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 750));
            const after = await captureEvidence(popup, reportDir, "protected-page-after-click");
            assert.equal(after.state.toast.hidden, true);
            assert.equal(after.state.results.skeletonCards, 0);
            assert.ok(
                Math.abs(after.state.body.scrollHeight - before.state.body.scrollHeight) <= 2,
                "blocked-page popup height should stay stable"
            );
            assertNoPopupOverflow(after.state);
            assertNoUnexpectedErrors(diagnostics);
            assertNoUnexpectedErrors(popupDiagnostics);
            await closePage(popup);
            await closePage(page);
            return { before, after };
        });

        await runCase(results, "regular page enables scan", async () => {
            await clearExtensionStorage(browser, extensionId);
            const page = await browser.newPage();
            const diagnostics = await attachPageDiagnostics(page, "regular-active-page");
            await page.goto(`${fixtureServer.origin}/event-page.html`, {
                waitUntil: "domcontentloaded",
            });
            const popup = await openExtensionPopup(browser, page, extensionId, extension);
            const popupDiagnostics = await attachPageDiagnostics(popup, "regular-popup");
            await waitForScanAvailability(popup);
            const evidence = await captureEvidence(popup, reportDir, "regular-page-ready");

            assert.equal(evidence.state.scanButton.disabled, false);
            assert.equal(evidence.state.scanButton.title, "Scan Page");
            assert.equal(evidence.state.scanSection.title, "");
            assert.equal(evidence.state.toast.hidden, true);
            assertNoPopupOverflow(evidence.state);
            assertNoUnexpectedErrors(diagnostics);
            assertNoUnexpectedErrors(popupDiagnostics);
            await closePage(popup);
            await closePage(page);
            return evidence;
        });

        await runCase(results, "page scan renders mock results and calendar tab", async () => {
            await clearExtensionStorage(browser, extensionId);
            const page = await browser.newPage();
            await page.goto(`${fixtureServer.origin}/event-page.html`, {
                waitUntil: "domcontentloaded",
            });
            const popup = await openExtensionPopup(browser, page, extensionId, extension);
            const popupDiagnostics = await attachPageDiagnostics(popup, "scan-popup");
            await waitForScanAvailability(popup);

            await popup.click("#scanBtn");
            await popup.waitForFunction(
                () => document.querySelectorAll(".skeleton-card").length > 0,
                { timeout: options.timeoutMs }
            );
            const scanning = await captureEvidence(popup, reportDir, "page-scan-scanning");
            assert.equal(scanning.state.scanButton.disabled, true);
            assert.ok(scanning.state.results.skeletonCards > 0);

            await waitForVisibleResults(popup);
            const resultsEvidence = await captureEvidence(popup, reportDir, "page-scan-results");
            assert.equal(resultsEvidence.state.results.eventCards, 10);
            assert.equal(resultsEvidence.state.results.pastCards, 10);
            assert.equal(resultsEvidence.state.results.upcomingCards, 0);
            assert.equal(resultsEvidence.state.addSelected.disabled, true);
            assertFirstCardVisible(resultsEvidence.state, "page scan");
            assertNoPopupOverflow(resultsEvidence.state);

            const firstCardPoint = await popup.$eval(".event-card", (card) => {
                card.scrollIntoView({ block: "center", inline: "nearest" });
                const rect = card.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            });
            await popup.mouse.click(firstCardPoint.x, firstCardPoint.y);
            try {
                await popup.waitForFunction(
                    () => document.querySelectorAll(".event-card.selected").length === 1 &&
                        document.getElementById("addSelectedBtn")?.disabled === false,
                    { timeout: options.timeoutMs }
                );
            } catch (error) {
                const afterClick = await captureEvidence(popup, reportDir, "page-scan-after-card-click");
                throw new Error(
                    `Event card click did not select a card. State: ${JSON.stringify(afterClick.state.results)}`,
                    { cause: error }
                );
            }

            let matchedCalendarUrl = "";
            const calendarTargetPromise = browser.waitForTarget(
                (target) => {
                    const url = target.url();
                    const matches = target.type() === "page" &&
                        url.includes("calendar.google.com/calendar/") &&
                        url.includes("eventedit");
                    if (matches) matchedCalendarUrl = url;
                    return matches;
                },
                { timeout: options.timeoutMs }
            );
            await popup.click("#addSelectedBtn");
            const calendarTarget = await calendarTargetPromise;
            const calendarPage = await calendarTarget.page();
            assert.ok(matchedCalendarUrl.includes("eventedit"));
            await closePage(calendarPage);

            assertNoUnexpectedErrors(popupDiagnostics);
            await closePage(popup);
            await closePage(page);
            return { scanning, results: resultsEvidence, calendarUrl: matchedCalendarUrl };
        });

        await runCase(results, "custom context persists and scans", async () => {
            await clearExtensionStorage(browser, extensionId);
            const page = await browser.newPage();
            await page.goto(`${fixtureServer.origin}/empty-page.html`, {
                waitUntil: "domcontentloaded",
            });
            let popup = await openExtensionPopup(browser, page, extensionId, extension);
            const firstDiagnostics = await attachPageDiagnostics(popup, "custom-popup-first");
            await waitForScanAvailability(popup);

            await popup.click("#customContextBtn");
            await popup.type(
                "#customInput",
                "Neighborhood potluck on October 8, 2026 at 6 PM at River Park Pavilion."
            );
            const openEvidence = await captureEvidence(popup, reportDir, "custom-context-open");
            assert.equal(openEvidence.state.customContext.hidden, false);
            assert.equal(openEvidence.state.scanSection.hidden, true);
            assert.match(openEvidence.state.customContext.textareaValue, /Neighborhood potluck/);
            assertNoPopupOverflow(openEvidence.state);
            await closePage(popup);

            popup = await openExtensionPopup(browser, page, extensionId, extension);
            const secondDiagnostics = await attachPageDiagnostics(popup, "custom-popup-second");
            await waitForScanAvailability(popup);
            const restored = await captureEvidence(popup, reportDir, "custom-context-restored");
            assert.equal(restored.state.customContext.hidden, false);
            assert.match(restored.state.customContext.textareaValue, /Neighborhood potluck/);

            await popup.click("#scanMediaBtn");
            await waitForVisibleResults(popup);
            const scanned = await captureEvidence(popup, reportDir, "custom-context-results");
            assert.equal(scanned.state.customContext.hidden, false);
            assert.equal(scanned.state.results.eventCards, 10);
            assertFirstCardVisible(scanned.state, "custom context");
            assertNoPopupOverflow(scanned.state);
            assertNoUnexpectedErrors(firstDiagnostics);
            assertNoUnexpectedErrors(secondDiagnostics);
            await closePage(popup);
            await closePage(page);
            return { open: openEvidence, restored, scanned };
        });

        await runCase(results, "iCalendar download shows open-file guidance", async () => {
            await clearExtensionStorage(browser, extensionId);
            const page = await browser.newPage();
            await page.goto(`${fixtureServer.origin}/event-page.html`, {
                waitUntil: "domcontentloaded",
            });
            const popup = await openExtensionPopup(browser, page, extensionId, extension);
            const popupDiagnostics = await attachPageDiagnostics(popup, "icalendar-popup");
            await waitForScanAvailability(popup);
            await popup.evaluate(async () => {
                await chrome.storage.sync.set({
                    settings: {
                        defaultCalendar: "icloud",
                    },
                });
            });

            await popup.click("#scanBtn");
            await waitForVisibleResults(popup);

            const firstCardPoint = await popup.$eval(".event-card", (card) => {
                card.scrollIntoView({ block: "center", inline: "nearest" });
                const rect = card.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            });
            await popup.mouse.click(firstCardPoint.x, firstCardPoint.y);
            await popup.waitForFunction(
                () => document.querySelectorAll(".event-card.selected").length === 1 &&
                    document.getElementById("addSelectedBtn")?.disabled === false,
                { timeout: options.timeoutMs }
            );

            await popup.click("#addSelectedBtn");
            await popup.waitForFunction(
                () => {
                    const toast = document.getElementById("toast");
                    return toast?.classList.contains("visible") &&
                        toast.innerText.includes("After it downloads, open the .ics file");
                },
                { timeout: options.timeoutMs }
            );

            const notice = await captureEvidence(popup, reportDir, "icalendar-download-notice");
            assert.equal(notice.state.toast.visible, true);
            assert.match(notice.state.toast.text, /After it downloads, open the \.ics file/);
            assertNoPopupOverflow(notice.state);
            assertNoUnexpectedErrors(popupDiagnostics);
            await closePage(popup);
            await closePage(page);
            return notice;
        });

        await runCase(results, "settings button opens usable settings page", async () => {
            await clearExtensionStorage(browser, extensionId);
            const page = await browser.newPage();
            await page.goto(`${fixtureServer.origin}/empty-page.html`, {
                waitUntil: "domcontentloaded",
            });
            const popup = await openExtensionPopup(browser, page, extensionId, extension);
            await waitForScanAvailability(popup);
            const settingsTargetPromise = browser.waitForTarget(
                (target) => target.type() === "page" &&
                    target.url().startsWith(`chrome-extension://${extensionId}${SETTINGS_PATH}`),
                { timeout: options.timeoutMs }
            );
            await popup.click("#settingsBtn");
            const settingsTarget = await settingsTargetPromise;
            const settingsPage = await settingsTarget.page();
            const settingsDiagnostics = await attachPageDiagnostics(settingsPage, "settings-page");
            await settingsPage.waitForSelector("#apiKeyMode", { timeout: options.timeoutMs });
            await settingsPage.waitForSelector("#defaultCalendar", { timeout: options.timeoutMs });
            const settingsState = await settingsPage.evaluate(() => ({
                title: document.title,
                apiKeyMode: document.getElementById("apiKeyMode")?.value,
                defaultCalendar: document.getElementById("defaultCalendar")?.value,
                timeFormat: document.getElementById("timeFormatSetting")?.value,
                bodyText: document.body.innerText,
            }));

            assert.equal(settingsState.title, "Eventy Settings");
            assert.equal(settingsState.apiKeyMode, "shared");
            assert.equal(settingsState.defaultCalendar, "google");
            assert.equal(settingsState.timeFormat, "12");
            assert.match(settingsState.bodyText, /API Settings/);
            assert.match(settingsState.bodyText, /Preferences/);
            assertNoUnexpectedErrors(settingsDiagnostics);
            await closePage(settingsPage);
            await closePage(popup);
            await closePage(page);
            return { state: settingsState };
        });

        await writeReport(reportDir, {
            generatedAt: new Date().toISOString(),
            headless: options.headless,
            mockDelayMs: options.mockDelayMs,
            chromePath,
            passed: results.every((result) => result.status === "passed"),
            results,
        });
    } finally {
        if (!results.every((result) => result.status === "passed")) {
            await writeReport(reportDir, {
                generatedAt: new Date().toISOString(),
                headless: options.headless,
                mockDelayMs: options.mockDelayMs,
                chromePath,
                passed: false,
                results,
            }).catch(() => {});
        }
        if (browser && !options.keepBrowser) {
            await closeBrowser(browser);
        } else if (browser) {
            console.log("browser left open because --keep-browser was set");
        }
        await closeServer(fixtureServer);
        if (!options.keepBrowser) {
            await removeTempRoot(tempRoot);
        }
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
