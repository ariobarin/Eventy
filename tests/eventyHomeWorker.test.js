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

test("eventy home maps nested assets to github pages assets", () => {
    assert.deepEqual(
        upstreamUrlForEventyHome("https://ariobarin.com/eventy-home/assets/icon128.png?v=1"),
        { upstreamUrl: "https://ariobarin.github.io/Eventy/assets/icon128.png?v=1" },
    );
});

test("eventy page declares a relative favicon", async () => {
    const page = await import("node:fs/promises").then((fs) =>
        fs.readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    );

    assert.match(page, /<link rel="icon" type="image\/png" sizes="128x128" href="\.\/assets\/icon128\.png">/);
    assert.match(page, /<link rel="apple-touch-icon" href="\.\/assets\/icon128\.png">/);
});
