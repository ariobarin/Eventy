const CACHE_TTL_MS = 15 * 60 * 1000;

export function makeCacheKey(url) {
    return `eventy-scan:${url || ""}`;
}

export async function loadCache(url, chromeApi = globalThis.chrome) {
    try {
        const key = makeCacheKey(url);
        const result = await chromeApi.storage.local.get(key);
        const cached = result[key];
        if (!cached || !Array.isArray(cached.events)) return null;
        if (
            typeof cached.ts !== "number" ||
            Date.now() - cached.ts > CACHE_TTL_MS
        ) {
            return null;
        }
        return cached;
    } catch (_) {
        return null;
    }
}

export async function saveCache(url, events, selectedIdxs, chromeApi = globalThis.chrome) {
    try {
        const key = makeCacheKey(url);
        const payload = { events, selected: selectedIdxs, ts: Date.now() };
        await chromeApi.storage.local.set({ [key]: payload });
    } catch (_) { }
}
