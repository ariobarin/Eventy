import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const distDir = path.join(root, "dist");
const zipName = `eventy-v${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);

const entries = [
    "manifest.json",
    "config.js",
    "assets",
    "src",
];

const excludedPrefixes = [
    "src/mocks/",
];

function shouldInclude(relativePath) {
    const normalized = relativePath.replaceAll(path.sep, "/");
    const name = path.basename(normalized);
    if (name.startsWith(".")) return false;
    return !excludedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function addEntry(fullPath, archivePath) {
    if (!shouldInclude(archivePath)) return;

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
        for (const child of fs.readdirSync(fullPath)) {
            addEntry(path.join(fullPath, child), path.join(archivePath, child));
        }
        return;
    }

    archive.file(fullPath, { name: archivePath.replaceAll(path.sep, "/") });
}

fs.rmSync(zipPath, { force: true });
fs.mkdirSync(distDir, { recursive: true });

const output = fs.createWriteStream(zipPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

output.on("close", () => {
    console.log(`Created ${path.relative(root, zipPath)} (${archive.pointer()} bytes)`);
});

archive.on("warning", (err) => {
    throw err;
});

archive.on("error", (err) => {
    throw err;
});

archive.pipe(output);

for (const entry of entries) {
    const fullPath = path.join(root, entry);
    addEntry(fullPath, entry);
}

await archive.finalize();
