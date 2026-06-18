export function isFreshScanResult(cached, scanStartedAt) {
    if (!cached || !Array.isArray(cached.events)) return false;
    if (typeof cached.ts !== "number") return false;
    if (typeof scanStartedAt !== "number") return false;
    return cached.ts >= scanStartedAt;
}
