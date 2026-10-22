import { isFreshScanResult } from "../utils/cache.js";
import {
    SCAN_POLL_BACKOFF_MULTIPLIER,
    SCAN_POLL_INITIAL_INTERVAL_MS,
    SCAN_POLL_MAX_ATTEMPTS,
    SCAN_POLL_MAX_INTERVAL_MS,
    SCAN_POLL_TIMEOUT_MS,
} from "./constants.js";

function isRateLimitMessage(stored) {
    return stored?.errorType === "RATE_LIMIT" ||
        (stored?.error && (
            stored.error.toLowerCase().includes("rate limit") ||
            stored.error.toLowerCase().includes("quota") ||
            stored.error.toLowerCase().includes("daily limit")
        ));
}

export function createScanPoller({
    storage = globalThis.chrome?.storage?.local,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
    nowFn = () => Date.now(),
    warn = () => { },
    error = () => { },
    onQuotaExceeded = () => { },
} = {}) {
    const pollTimeouts = new Map();

    let deferredTimeoutId = null;

    async function pollForResults(url, storageKey, onComplete, onError, options = {}) {
        let currentInterval = SCAN_POLL_INITIAL_INTERVAL_MS;
        let attempts = 0;
        const startTime = nowFn();
        const isDeferred = !url;

        const cleanup = () => {
            if (url) pollTimeouts.delete(url);
            else deferredTimeoutId = null;
        };

        const poll = async () => {
            try {
                attempts++;
                const elapsedTime = nowFn() - startTime;

                if (attempts >= SCAN_POLL_MAX_ATTEMPTS || elapsedTime >= SCAN_POLL_TIMEOUT_MS) {
                    warn(`[Eventy] Polling timeout after ${attempts} attempts (${elapsedTime}ms)`);
                    cleanup();
                    if (isDeferred) {
                        await storage.remove(storageKey);
                    }
                    onError();
                    return;
                }

                let isReady = false;
                let resultData = null;

                if (isDeferred) {
                    const result = await storage.get(storageKey);
                    const stored = result[storageKey];

                    if (!stored) {
                        onError();
                        return;
                    }

                    if (stored.status === "complete") {
                        isReady = true;
                        resultData = stored;
                        await storage.remove(storageKey);
                    } else if (stored.status === "error") {
                        await storage.remove(storageKey);
                        if (isRateLimitMessage(stored)) {
                            onQuotaExceeded();
                            cleanup();
                            return;
                        }
                        onError();
                        return;
                    }
                } else {
                    const key = `eventy-scan:${url}`;
                    const scanningKey = `eventy-scanning:${url}`;
                    const checkResult = await storage.get([key, scanningKey]);
                    const cached = checkResult[key];
                    const scanning = checkResult[scanningKey];
                    const minimumResultTs = options.minimumResultTs;

                    if (isFreshScanResult(cached, minimumResultTs)) {
                        isReady = true;
                        resultData = cached;
                    } else if (!scanning) {
                        cleanup();
                        onError();
                        return;
                    }
                }

                if (isReady) {
                    cleanup();
                    onComplete(resultData);
                    return;
                }

                currentInterval = Math.min(
                    currentInterval * SCAN_POLL_BACKOFF_MULTIPLIER,
                    SCAN_POLL_MAX_INTERVAL_MS
                );

                const timeoutId = setTimeoutFn(poll, currentInterval);
                if (url) pollTimeouts.set(url, timeoutId);
                else deferredTimeoutId = timeoutId;
            } catch (err) {
                error(err);
                cleanup();
                onError();
            }
        };

        const initialTimeoutId = setTimeoutFn(poll, currentInterval);
        if (url) pollTimeouts.set(url, initialTimeoutId);
        else deferredTimeoutId = initialTimeoutId;
    }

    function clearForUrl(url) {
        const timeout = pollTimeouts.get(url);
        if (timeout) clearTimeoutFn(timeout);
        pollTimeouts.delete(url);
    }

    function clearAll() {
        for (const timeout of pollTimeouts.values()) {
            if (timeout) clearTimeoutFn(timeout);
        }
        pollTimeouts.clear();
        if (deferredTimeoutId) {
            clearTimeoutFn(deferredTimeoutId);
            deferredTimeoutId = null;
        }
    }

    return {
        pollForResults,
        clearForUrl,
        clearAll,
    };
}
