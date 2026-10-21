import { error } from "./logger.js";

/**
 * Get or create the anonymous installation ID used for shared rate limiting.
 */
export async function getInstallationId() {
    try {
        const { installationId } = await chrome.storage.local.get("installationId");
        if (installationId) return installationId;
        const newId = crypto.randomUUID();
        await chrome.storage.local.set({ installationId: newId });
        return newId;
    } catch (err) {
        error("[Eventy] Error getting installation ID:", err);
        return null;
    }
}
