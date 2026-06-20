const PROTECTED_CHROME_PAGE_MESSAGE =
    "Chrome pages cannot be scanned.";
const CHROME_WEBSTORE_MESSAGE =
    "Chrome Web Store pages cannot be scanned.";
const PROTECTED_PAGE_MESSAGE =
    "This page cannot be scanned.";

const PROTECTED_PROTOCOLS = new Set([
    "about:",
    "chrome:",
    "chrome-extension:",
    "devtools:",
    "edge:",
]);

const SCRIPTING_ACCESS_ERROR_PATTERNS = [
    "cannot access contents of url",
    "cannot access a chrome",
    "cannot be scripted",
    "extensions gallery cannot be scripted",
    "page cannot be scripted",
];

function parseUrl(url) {
    if (!url) return null;
    try {
        return new URL(url);
    } catch (_) {
        return null;
    }
}

function isChromeWebStoreUrl(parsedUrl) {
    return parsedUrl.hostname === "chromewebstore.google.com" ||
        (parsedUrl.hostname === "chrome.google.com" &&
            parsedUrl.pathname.startsWith("/webstore"));
}

export function getTabScanBlockReason(url) {
    if (!url) return null;

    const parsedUrl = parseUrl(url);
    if (!parsedUrl) return null;

    if (isChromeWebStoreUrl(parsedUrl)) {
        return CHROME_WEBSTORE_MESSAGE;
    }

    if (PROTECTED_PROTOCOLS.has(parsedUrl.protocol)) {
        return PROTECTED_CHROME_PAGE_MESSAGE;
    }

    return null;
}

export function getRequiredTabScanBlockReason(url) {
    return url ? getTabScanBlockReason(url) : PROTECTED_PAGE_MESSAGE;
}

export function getScriptInjectionFailureMessage(url, err) {
    const knownBlockReason = getTabScanBlockReason(url);
    if (knownBlockReason) return knownBlockReason;

    const message = (err?.message || String(err || "")).toLowerCase();
    if (SCRIPTING_ACCESS_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
        return PROTECTED_PAGE_MESSAGE;
    }

    return null;
}

export function createTabScanAccessError(message) {
    const err = new Error(message);
    err.name = "TabScanAccessError";
    err.userMessage = message;
    return err;
}

export function isTabScanAccessError(err) {
    return err?.name === "TabScanAccessError";
}
