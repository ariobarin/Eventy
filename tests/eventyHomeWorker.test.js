import test from "node:test";
import assert from "node:assert/strict";

import { upstreamUrlForEventyHome } from "../workers/eventyHome.js";

test("eventy home redirects bare path to trailing slash", () => {
    assert.deepEqual(
        upstreamUrlForEventyHome("https://ariobarin.com/eventy-home"),
        { redirectUrl: "https://ariobarin.com/eventy-home/" },
    );
});

test("eventy home maps root requests to github pages root", () => {
    assert.deepEqual(
        upstreamUrlForEventyHome("https://ariobarin.com/eventy-home/"),
        { upstreamUrl: "https://ariobarin.github.io/Eventy/" },
    );
});

test("eventy subdomain maps root requests to github pages root", () => {
    assert.deepEqual(
        upstreamUrlForEventyHome("https://eventy.ariobarin.com/"),
        { upstreamUrl: "https://ariobarin.github.io/Eventy/" },
    );
});

test("eventy home maps nested assets to github pages assets", () => {
    assert.deepEqual(
        upstreamUrlForEventyHome("https://ariobarin.com/eventy-home/assets/icon128.png?v=1"),
        { upstreamUrl: "https://ariobarin.github.io/Eventy/assets/icon128.png?v=1" },
    );
});

test("eventy subdomain maps nested assets to github pages assets", () => {
    assert.deepEqual(
        upstreamUrlForEventyHome("https://eventy.ariobarin.com/assets/icon128.png?v=1"),
        { upstreamUrl: "https://ariobarin.github.io/Eventy/assets/icon128.png?v=1" },
    );
});

test("eventy home worker declares the canonical custom domain", async () => {
    const config = await import("node:fs/promises").then((fs) =>
        fs.readFile(new URL("../wrangler.home.jsonc", import.meta.url), "utf8"),
    );
    const wrangler = JSON.parse(config);

    assert.deepEqual(
        wrangler.routes.find((route) => route.pattern === "eventy.ariobarin.com"),
        { pattern: "eventy.ariobarin.com", custom_domain: true },
    );
});

test("eventy page declares a relative favicon", async () => {
    const page = await import("node:fs/promises").then((fs) =>
        fs.readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    );

    assert.match(page, /<link rel="canonical" href="https:\/\/eventy\.ariobarin\.com\/">/);
    assert.match(page, /<link rel="icon" type="image\/png" sizes="128x128" href="\.\/assets\/icon128\.png">/);
    assert.match(page, /<link rel="apple-touch-icon" href="\.\/assets\/icon128\.png">/);
});
