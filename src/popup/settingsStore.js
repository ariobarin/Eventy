import { DEFAULT_POPUP_SETTINGS } from "./constants.js";
import { error as defaultError } from "../utils/logger.js";

export function createPopupSettingsStore({
    chromeApi = globalThis.chrome,
    logger = defaultError,
} = {}) {
    let cachedSettings = { ...DEFAULT_POPUP_SETTINGS };
    let settingsReadyPromise = null;

    async function loadSettingsFromStorage() {
        try {
            const result = await chromeApi.storage.sync.get("settings");
            cachedSettings = {
                ...DEFAULT_POPUP_SETTINGS,
                ...(result.settings || {}),
            };
            return cachedSettings;
        } catch (err) {
            logger("Error loading settings:", err);
            cachedSettings = { ...DEFAULT_POPUP_SETTINGS };
            return cachedSettings;
        }
    }

    function ensureSettingsLoaded() {
        if (!settingsReadyPromise) {
            settingsReadyPromise = loadSettingsFromStorage();
        }
        return settingsReadyPromise;
    }

    function getTimeFormatPreference() {
        return cachedSettings.timeFormat === "24" ? "24" : "12";
    }

    return {
        ensureSettingsLoaded,
        loadSettingsFromStorage,
        getTimeFormatPreference,
    };
}
