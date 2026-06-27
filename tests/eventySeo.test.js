import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { JSDOM } from "jsdom";

const ROOT_URL = "https://eventy.ariobarin.com/";
const DESCRIPTION =
    "Eventy is a Chrome extension that turns web pages, selected text, emails, flyers, or screenshots into Google Calendar or iCalendar events with AI.";
const WEBSTORE_SUMMARY =
    "Turn web pages, selected text, emails, flyers, and screenshots into Google Calendar or iCalendar events with AI.";

async function readText(path) {
    return readFile(new URL(path, import.meta.url), "utf8");
}

async function readBytes(path) {
    return readFile(new URL(path, import.meta.url));
}

async function readDom(path) {
    const html = await readText(path);
    return new JSDOM(html).window.document;
}

function contentOf(document, selector) {
    const element = document.querySelector(selector);
    assert.ok(element, `missing ${selector}`);
    return element.getAttribute("content");
}

test("homepage declares search and social metadata", async () => {
    const document = await readDom("../docs/index.html");

    assert.equal(document.title, "Eventy: AI event extractor for any calendar");
    assert.equal(contentOf(document, 'meta[name="description"]'), DESCRIPTION);
    assert.equal(document.querySelector('link[rel="canonical"]')?.href, ROOT_URL);
    assert.equal(contentOf(document, 'meta[property="og:title"]'), "Eventy: AI event extractor for any calendar");
    assert.equal(contentOf(document, 'meta[property="og:description"]'), DESCRIPTION);
    assert.equal(contentOf(document, 'meta[property="og:url"]'), ROOT_URL);
    assert.equal(contentOf(document, 'meta[property="og:type"]'), "website");
    assert.equal(contentOf(document, 'meta[property="og:image"]'), `${ROOT_URL}assets/eventy-social-preview.png`);
    assert.equal(contentOf(document, 'meta[property="og:image:width"]'), "1200");
    assert.equal(contentOf(document, 'meta[property="og:image:height"]'), "630");
    assert.equal(
        contentOf(document, 'meta[property="og:image:alt"]'),
        "Eventy turning page details into a calendar event",
    );
    assert.equal(contentOf(document, 'meta[name="twitter:card"]'), "summary_large_image");
    assert.equal(contentOf(document, 'meta[name="twitter:title"]'), "Eventy: AI event extractor for any calendar");
    assert.equal(contentOf(document, 'meta[name="twitter:description"]'), DESCRIPTION);
    assert.equal(contentOf(document, 'meta[name="twitter:image"]'), `${ROOT_URL}assets/eventy-social-preview.png`);
    assert.equal(
        contentOf(document, 'meta[name="twitter:image:alt"]'),
        "Eventy turning page details into a calendar event",
    );
});

test("homepage includes software application structured data", async () => {
    const document = await readDom("../docs/index.html");
    const script = document.querySelector('script[type="application/ld+json"]');
    assert.ok(script, "missing JSON-LD script");

    const data = JSON.parse(script.textContent);

    assert.equal(data["@context"], "https://schema.org");
    assert.equal(data["@type"], "SoftwareApplication");
    assert.equal(data.name, "Eventy");
    assert.equal(data.url, ROOT_URL);
    assert.equal(data.applicationCategory, "UtilitiesApplication");
    assert.equal(data.operatingSystem, "Chrome");
    assert.equal(data.browserRequirements, "Requires Google Chrome or a Chromium-based browser");
    assert.equal(data.downloadUrl, "https://chromewebstore.google.com/detail/eventy/kfancgcbhdkeohknmidbnioccmmoknjl");
    assert.equal(data.softwareVersion, "1.2.1");
    assert.equal(data.offers?.price, "0");
    assert.equal(data.offers?.priceCurrency, "USD");
    assert.equal(data.image, `${ROOT_URL}assets/eventy-social-preview.png`);
    assert.equal(data.aggregateRating, undefined);
    assert.equal(data.review, undefined);
    assert.ok(data.description.includes("web pages"));
    assert.ok(data.description.includes("iCalendar"));
});

test("homepage has crawlable product content and support links", async () => {
    const document = await readDom("../docs/index.html");
    const pageText = document.body.textContent.replace(/\s+/g, " ");

    for (const phrase of [
        "Scan web pages and selected text",
        "Read flyers, screenshots, and images",
        "Review before adding",
        "Export to Google Calendar or iCalendar",
        "Privacy and control",
        "Bring your own OpenRouter key",
        "AI event extractor",
        "Chrome extension",
    ]) {
        assert.match(pageText, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }

    assert.ok(document.querySelector('a[href="mailto:eventy.sup@gmail.com"]'));
    assert.ok(document.querySelector('a[href="https://github.com/ariobarin/Eventy/issues"]'));
});

test("privacy and terms pages declare canonical metadata", async () => {
    const privacy = await readDom("../docs/privacy.html");
    const terms = await readDom("../docs/terms.html");

    assert.equal(
        contentOf(privacy, 'meta[name="description"]'),
        "Privacy details for Eventy, the Chrome extension that turns selected content into calendar events with AI.",
    );
    assert.equal(privacy.querySelector('link[rel="canonical"]')?.href, `${ROOT_URL}privacy.html`);

    assert.equal(
        contentOf(terms, 'meta[name="description"]'),
        "Terms for using Eventy to review extracted event details and add them to your calendar.",
    );
    assert.equal(terms.querySelector('link[rel="canonical"]')?.href, `${ROOT_URL}terms.html`);
});

test("privacy surfaces distinguish extension tracking from website measurement", async () => {
    const privacyHtml = await readText("../docs/privacy.html");
    const privacyMarkdown = await readText("../PRIVACY.md");
    const combined = `${privacyHtml}\n${privacyMarkdown}`;
    const staleTrackingClaim = new RegExp(["No third", "party trackers are embedded"].join("-"), "i");

    assert.match(combined, /extension does not embed third-party trackers/i);
    assert.match(combined, /Cloudflare traffic measurement/i);
    assert.doesNotMatch(combined, staleTrackingClaim);
});

test("sitemap and robots expose canonical crawl paths", async () => {
    const sitemap = await readText("../docs/sitemap.xml");
    const robots = await readText("../docs/robots.txt");

    for (const url of [ROOT_URL, `${ROOT_URL}privacy.html`, `${ROOT_URL}terms.html`]) {
        assert.match(sitemap, new RegExp(`<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>`));
    }

    assert.match(robots, /User-agent: \*/);
    assert.match(robots, /Allow: \//);
    assert.match(robots, new RegExp(`Sitemap: ${ROOT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}sitemap.xml`));
    assert.doesNotMatch(robots, /Disallow: \//);
});

test("social preview image is a 1200 by 630 png", async () => {
    const image = await readBytes("../docs/assets/eventy-social-preview.png");

    assert.equal(image.toString("ascii", 1, 4), "PNG");
    assert.equal(image.readUInt32BE(16), 1200);
    assert.equal(image.readUInt32BE(20), 630);
});

test("web store description draft aligns with SEO positioning", async () => {
    const description = await readText("../webstore-docs/STORE_DESCRIPTION.txt");
    const [summary] = description.split(/\r?\n/);

    assert.equal(summary, WEBSTORE_SUMMARY);
    assert.match(description, /Eventy is a Chrome extension/);
    assert.match(description, /Google Calendar or iCalendar events with AI/);
    assert.doesNotMatch(description, /No tracking, no analytics, no data collection/);
});
