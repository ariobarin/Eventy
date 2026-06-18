import { debug, error } from "./logger.js";

/**
 * Get or create installation ID for rate limiting.
 */
export async function getInstallationId() {
    try {
        const result = await chrome.storage.local.get("installationId");
        if (result.installationId) {
            return result.installationId;
        }
        const newId = crypto.randomUUID();
        await chrome.storage.local.set({ installationId: newId });
        return newId;
    } catch (err) {
        // Use debug or error depending on context, or just console.error if logger not available in context (but it likely is)
        // We act defensively here.
        try {
            error("[Eventy] Error getting installation ID:", err);
        } catch (_) {
            console.error("[Eventy] Error getting installation ID:", err);
        }
        return null; // Return null on failure, consumer handles it
    }
}
