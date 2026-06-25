import fs from "node:fs/promises";
import path from "node:path";

import {
    findChromeExecutable,
    fixturePathForEntry,
    loadRealPageCorpus,
    REAL_PAGE_FIXTURE_DIR,
} from "./real-page-fixtures.mjs";

async function importPuppeteer() {
    try {
        return await import("puppeteer-core");
    } catch (error) {
        throw new Error(
            "Missing puppeteer-core. Run npm install before capturing real-page fixtures.",
            { cause: error }
        );
    }
}

function selectedEntries(corpus) {
    const names = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
    if (!names.length) return corpus;

    const wanted = new Set(names);
    return corpus.filter((entry) => wanted.has(entry.name));
}

async function captureEntry(browser, entry) {
    const page = await browser.newPage();
    try {
        await page.goto(entry.url, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });
        await page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(
            () => {}
        );

        const snapshot = await page.evaluate(() => ({
            html: document.documentElement.outerHTML,
            text: document.body ? document.body.innerText : "",
            title: document.title,
            lang: document.documentElement ? document.documentElement.lang : "",
            finalUrl: location.href,
        }));

        return {
            ...entry,
            ...snapshot,
            capturedAt: new Date().toISOString(),
        };
    } finally {
        await page.close().catch(() => {});
    }
}

async function main() {
    const corpus = selectedEntries(await loadRealPageCorpus());
    if (!corpus.length) {
        throw new Error("No matching real-page corpus entries were selected.");
    }

    const chromePath = findChromeExecutable();
    if (!chromePath) {
        throw new Error("Chrome was not found. Set CHROME_PATH and retry.");
    }

    await fs.mkdir(REAL_PAGE_FIXTURE_DIR, { recursive: true });

    const { default: puppeteer } = await importPuppeteer();
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: process.env.EVENTY_REAL_PAGE_HEADFUL === "1" ? false : "new",
        defaultViewport: { width: 1365, height: 900 },
        args: [
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate,OptimizationHints",
        ],
    });

    try {
        for (const entry of corpus) {
            const snapshot = await captureEntry(browser, entry);
            const fixturePath = fixturePathForEntry(entry);
            await fs.writeFile(fixturePath, JSON.stringify(snapshot, null, 2));
            const relativePath = path.relative(process.cwd(), fixturePath);
            console.log(
                `captured ${entry.name} text=${snapshot.text.length} html=${snapshot.html.length} path=${relativePath}`
            );
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
