import { applyTheme } from "./theme.js";
import { attachApiKeyAutoValidation } from "./autoValidate.js";
import { error } from "../utils/logger.js";
import { PROXY_URL } from "../../config.js";
import { getInstallationId } from "../utils/storage.js";

// Settings page functionality

// Default settings
const defaultSettings = {
    darkModeSettings: "auto",
    showPageMarkers: false,
    apiKeyMode: "shared",
};

// getInstallationId imported from utils/storage.js

async function postProxyJson(path, body) {
    const response = await fetch(`${PROXY_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = payload?.error?.message || payload?.error || `Request failed: ${response.status}`;
        throw new Error(message);
    }

    return payload;
}

/**
 * Fetch available BYOK models through the Eventy proxy.
 * Only returns models that support structured_outputs.
 */
async function fetchAvailableModels() {
    try {
        const data = await postProxyJson("/models");
        if (!data.data || !Array.isArray(data.data)) {
            return null;
        }

        // Filter for models that support structured_outputs
        const structuredModels = data.data.filter(model =>
            model.supported_parameters &&
            model.supported_parameters.includes("structured_outputs")
        );

        // Sort by name and group by provider
        structuredModels.sort((a, b) => a.name.localeCompare(b.name));

        return structuredModels;
    } catch (err) {
        error("Error fetching models:", err);
        return null;
    }
}

/**
 * Populate the model dropdown with fetched models using Choices.js.
 */
function populateModelDropdown(models) {
    if (!modelChoices) return;

    if (!models || models.length === 0) {
        return;
    }

    // Group models by provider (first part of the id before /)
    const grouped = {};
    for (const model of models) {
        const provider = model.id.split("/")[0];
        if (!grouped[provider]) {
            grouped[provider] = [];
        }
        let label = model.name;
        if (model.id === "google/gemini-2.5-flash-lite-preview-09-2025") {
            label += " (Recommended)";
        }
        grouped[provider].push({
            value: model.id,
            label: label,
        });
    }

    // Sort providers with preferred order
    const providerOrder = ["anthropic", "openai", "google", "meta-llama", "mistralai", "deepseek", "cohere"];
    const sortedProviders = Object.keys(grouped).sort((a, b) => {
        const aIndex = providerOrder.indexOf(a);
        const bIndex = providerOrder.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });

    // Build choices array with groups
    const choices = [
        { value: "", label: "Default shared model", selected: true }
    ];

    for (const provider of sortedProviders) {
        choices.push({
            label: formatProviderName(provider),
            choices: grouped[provider],
        });
    }

    // Update Choices.js with grouped models
    modelChoices.clearStore();
    modelChoices.setChoices(choices, "value", "label", true);

    // Restore previously selected model if any
    chrome.storage.local.get("userModel").then((result) => {
        if (result.userModel) {
            modelChoices.setChoiceByValue(result.userModel);
        }
    });
}

/**
 * Format provider name for display.
 */
function formatProviderName(provider) {
    const names = {
        "anthropic": "Anthropic",
        "openai": "OpenAI",
        "google": "Google",
        "meta-llama": "Meta Llama",
        "mistralai": "Mistral AI",
        "deepseek": "DeepSeek",
        "cohere": "Cohere",
        "microsoft": "Microsoft",
        "amazon": "Amazon",
        "qwen": "Qwen",
    };
    return names[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Choices.js instance for model selector
let modelChoices = null;



/**
 * Initialize Choices.js on the model select element.
 */
function initModelSelect() {
    const selectEl = document.getElementById("modelSelect");
    if (!selectEl || modelChoices) return;

    modelChoices = new Choices(selectEl, {
        searchEnabled: true,
        searchPlaceholderValue: "Search or paste model slug...",
        itemSelectText: "",
        shouldSort: false,
        searchResultLimit: 100,
        noResultsText: "No models found",
        noChoicesText: "No models available",
        searchFloor: 1,
        fuseOptions: {
            threshold: 0.3,
            distance: 100,
            ignoreLocation: true,
        },
    });

    // Add custom class after initialization
    const container = selectEl.closest(".choices");
    if (container) {
        container.classList.add("model-choices");
    }
}

/**
 * Validate an OpenRouter API key through the Eventy proxy.
 */
async function validateApiKey(apiKey) {
    const parseNumber = (value) => {
        if (value === null || value === undefined) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    };

    const getBalanceStatus = (data) => {
        const limit = parseNumber(data?.limit);
        const usage = parseNumber(data?.usage) ?? 0;
        const limitRemaining = parseNumber(data?.limit_remaining);

        if (limitRemaining !== null) {
            return { hasBalance: limitRemaining > 0, limit, usage, remaining: limitRemaining };
        }

        if (limit !== null) {
            const remaining = limit - usage;
            return { hasBalance: remaining > 0, limit, usage, remaining };
        }

        return { hasBalance: true, limit, usage, remaining: null };
    };

    try {
        const payload = await postProxyJson("/validate-key", { apiKey });
        const data = payload?.data;
        if (!data) {
            return { valid: false, error: "Invalid API key" };
        }

        const balance = getBalanceStatus(data);
        if (!balance.hasBalance) {
            return { valid: false, error: "No balance remaining on this key" };
        }

        return { valid: true, data };
    } catch (err) {
        if (err.name === "TypeError" && err.message.includes("fetch")) {
            return { valid: false, error: "Network error - check proxy connectivity" };
        }
        return { valid: false, error: err.message || "Failed to validate key" };
    }
}

/**
 * Fetch usage stats from the proxy.
 */
async function fetchUsageStats() {
    try {
        const installationId = await getInstallationId();
        if (!installationId) {
            return null;
        }

        // Check if BYOK mode
        const localData = await chrome.storage.local.get("apiKey");
        const syncData = await chrome.storage.sync.get("settings");
        const isByok = syncData.settings?.apiKeyMode === "byok" && localData.apiKey;

        const headers = {};
        if (isByok) {
            headers["X-User-Api-Key"] = localData.apiKey;
        }

        const usageUrl = `${PROXY_URL}/usage?id=${encodeURIComponent(installationId)}`;
        const response = await fetch(usageUrl, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (err) {
        error("Error fetching usage stats:", err);
        return null;
    }
}

/**
 * Format a number with commas.
 */
function formatNumber(num) {
    if (num === undefined || num === null) {
        return "-";
    }
    return num.toLocaleString();
}

/**
 * Format the reset time.
 */
function formatTimeRemaining(resetsAt) {
    try {
        const date = new Date(resetsAt);
        const use24h = lastSavedSettings?.timeFormat === "24";

        return date.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            hour12: !use24h
        });
    } catch {
        return "-";
    }
}

// Cache of last saved/loaded settings to avoid data loss and unnecessary writes
let lastSavedSettings = null;

// Load settings from storage
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get("settings");
        // Merge with defaults to ensure all keys exist
        return { ...defaultSettings, ...(result.settings || {}) };
    } catch (err) {
        error("Error loading settings:", err);
        return defaultSettings;
    }
}

// Save settings to storage
async function saveSettings(settings) {
    try {
        await chrome.storage.sync.set({ settings });
        return true;
    } catch (err) {
        error("Error saving settings:", err);
        // Surface error to caller for non-blocking UI handling
        throw err;
    }
}

// Initialize the settings page
async function initSettingsPage() {
    const settings = await loadSettings();
    lastSavedSettings = { ...settings };

    // Initialize Choices.js for model selector
    initModelSelect();

    // Apply loaded settings to UI
    applySettingsToUI(settings);

    // Apply theme immediately
    applyTheme(settings.darkModeSettings);

    // Set up event listeners
    setupEventListeners();

    // Load usage stats
    refreshUsageDisplay();

    // The proxy is the source of truth for shared limits.
    updateLimitLabels(null);
}

/**
 * Update UI labels that mention the daily limit.
 */
function updateLimitLabels(dayLimit) {
    const sharedOption = document.getElementById("sharedOption");
    const requestLimit = document.getElementById("requestLimit");
    const formattedLimit = Number.isFinite(dayLimit) ? formatNumber(dayLimit) : "-";

    if (sharedOption) {
        sharedOption.textContent = Number.isFinite(dayLimit)
            ? `Use shared service (${formattedLimit}/day)`
            : "Use shared service";
    }
    if (requestLimit) {
        requestLimit.textContent = formattedLimit;
    }
}

// Apply settings to the UI elements
function applySettingsToUI(settings) {
    // Select dropdown for dark mode
    const darkModeSelect = document.getElementById("darkModeSettings");
    if (darkModeSelect) {
        darkModeSelect.value = settings.darkModeSettings || "auto";
    }

    // Select dropdown for default calendar
    const defaultCalendarSelect = document.getElementById("defaultCalendar");
    if (defaultCalendarSelect) {
        defaultCalendarSelect.value = settings.defaultCalendar || "google";
    }

    const timeFormatSelect = document.getElementById("timeFormatSetting");
    if (timeFormatSelect) {
        timeFormatSelect.value = settings.timeFormat || "12";
    }

    // Page markers toggle
    const showPageMarkersCheckbox = document.getElementById("showPageMarkers");
    if (showPageMarkersCheckbox) {
        showPageMarkersCheckbox.checked = settings.showPageMarkers === true; // Default to false
    }

    // API Key Mode
    const apiKeyModeSelect = document.getElementById("apiKeyMode");
    if (apiKeyModeSelect) {
        apiKeyModeSelect.value = settings.apiKeyMode || "shared";
        updateByokSectionVisibility(settings.apiKeyMode || "shared");
    }
}

// Update BYOK section visibility based on mode
function updateByokSectionVisibility(mode) {
    const byokSection = document.getElementById("byokSection");
    const usageStatsBox = document.getElementById("usageStats");

    if (byokSection) {
        if (mode === "byok") {
            byokSection.classList.remove("hidden");
        } else {
            byokSection.classList.add("hidden");
        }
    }

    // Hide entire usage stats section for BYOK mode
    if (usageStatsBox) {
        if (mode === "byok") {
            usageStatsBox.classList.add("hidden");
        } else {
            usageStatsBox.classList.remove("hidden");
        }
    }
}

// Get current settings from UI
function getSettingsFromUI() {
    // Start from last saved settings to prevent overwriting unrelated keys
    const settings = lastSavedSettings
        ? { ...lastSavedSettings }
        : { ...defaultSettings };

    // Only update dark mode setting from UI
    const darkModeSelect = document.getElementById("darkModeSettings");
    if (darkModeSelect) {
        settings.darkModeSettings = darkModeSelect.value;
    }

    // Update default calendar setting from UI
    const defaultCalendarSelect = document.getElementById("defaultCalendar");
    if (defaultCalendarSelect) {
        settings.defaultCalendar = defaultCalendarSelect.value;
    }

    const timeFormatSelect = document.getElementById("timeFormatSetting");
    if (timeFormatSelect) {
        settings.timeFormat = timeFormatSelect.value;
    }

    // Page markers toggle
    const showPageMarkersCheckbox = document.getElementById("showPageMarkers");
    if (showPageMarkersCheckbox) {
        settings.showPageMarkers = showPageMarkersCheckbox.checked;
    }

    // API Key Mode
    const apiKeyModeSelect = document.getElementById("apiKeyMode");
    if (apiKeyModeSelect) {
        settings.apiKeyMode = apiKeyModeSelect.value;
    }

    return settings;
}

// Set up event listeners
function setupEventListeners() {
    const promptClose = document.getElementById("prompt-close");

    // Select dropdown (only dark mode is visible)
    const darkModeSelect = document.getElementById("darkModeSettings");
    if (darkModeSelect) {
        darkModeSelect.addEventListener("change", (e) => {
            // Apply theme immediately when changed
            applyTheme(e.target.value);
            scheduleAutosave();
        });
    }

    // Default calendar select dropdown
    const defaultCalendarSelect = document.getElementById("defaultCalendar");
    if (defaultCalendarSelect) {
        defaultCalendarSelect.addEventListener("change", () => {
            scheduleAutosave();
        });
    }

    const timeFormatSelect = document.getElementById("timeFormatSetting");
    if (timeFormatSelect) {
        timeFormatSelect.addEventListener("change", () => {
            scheduleAutosave();
        });
    }

    // Page markers toggle
    const showPageMarkersCheckbox = document.getElementById("showPageMarkers");
    if (showPageMarkersCheckbox) {
        showPageMarkersCheckbox.addEventListener("change", () => {
            scheduleAutosave();
        });
    }

    // API Key Mode dropdown
    const apiKeyModeSelect = document.getElementById("apiKeyMode");
    if (apiKeyModeSelect) {
        apiKeyModeSelect.addEventListener("change", (e) => {
            updateByokSectionVisibility(e.target.value);
            scheduleAutosave();
            // Refresh usage display
            refreshUsageDisplay();
        });
    }

    // API Key input
    const apiKeyInput = document.getElementById("apiKeyInput");
    if (apiKeyInput) {
        // Load saved API key
        chrome.storage.local.get("apiKey").then((result) => {
            if (result.apiKey) {
                apiKeyInput.value = result.apiKey;
            }
        });
    }

    // Model select dropdown
    const modelSelect = document.getElementById("modelSelect");
    if (modelSelect) {
        // Load available models through the proxy. This does not use BYOK credits.
        chrome.storage.local.get(["apiKey", "userModel"]).then(async (result) => {
            const models = await fetchAvailableModels();
            if (models && models.length > 0) {
                populateModelDropdown(models);
            }
            // Set saved model selection after populating (Choices.js handles this)
            if (result.userModel && modelChoices) {
                modelChoices.setChoiceByValue(result.userModel);
            }
        });

        // Save on change (Choices.js fires change events on the underlying select)
        modelSelect.addEventListener("change", () => {
            scheduleModelSave();
        });
    }

    // Toggle key visibility
    const toggleKeyBtn = document.getElementById("toggleKeyVisibility");
    if (toggleKeyBtn && apiKeyInput) {
        toggleKeyBtn.addEventListener("click", () => {
            const isPassword = apiKeyInput.type === "password";
            apiKeyInput.type = isPassword ? "text" : "password";
            document.getElementById("eyeIcon").classList.toggle("hidden", !isPassword);
            document.getElementById("eyeOffIcon").classList.toggle("hidden", isPassword);
        });
    }

    // Validate key button
    const validateKeyBtn = document.getElementById("validateKeyBtn");
    if (validateKeyBtn && apiKeyInput) {
        attachApiKeyAutoValidation({
            inputEl: apiKeyInput,
            triggerValidate: () => {
                if (!validateKeyBtn.disabled) {
                    validateKeyBtn.click();
                }
            },
            debounceMs: 150,
            minLength: 8,
        });

        validateKeyBtn.addEventListener("click", async () => {
            const apiKey = apiKeyInput.value.trim();
            if (!apiKey) {
                showValidationStatus("Please enter an API key", "error");
                return;
            }

            validateKeyBtn.disabled = true;
            validateKeyBtn.classList.add("validating");
            validateKeyBtn.textContent = "Validating...";
            showValidationStatus("Validating key...", "validating");

            try {
                const result = await validateApiKey(apiKey);

                if (result.valid) {
                    // Save the API key to local storage
                    await chrome.storage.local.set({ apiKey });

                    const parseNumber = (value) => {
                        if (value === null || value === undefined) return null;
                        const num = Number(value);
                        return Number.isFinite(num) ? num : null;
                    };

                    let balanceMsg = "";
                    if (result.data) {
                        const limit = parseNumber(result.data.limit);
                        const usage = parseNumber(result.data.usage) ?? 0;
                        const remaining = parseNumber(result.data.limit_remaining);

                        if (remaining !== null) {
                            balanceMsg = ` | Remaining: $${remaining.toFixed(2)}`;
                        } else if (limit !== null) {
                            const computedRemaining = limit - usage;
                            balanceMsg = ` | Remaining: $${computedRemaining.toFixed(2)}`;
                        } else {
                            balanceMsg = ` | Usage: $${usage.toFixed(2)}`;
                        }
                    }

                    // Fetch and populate available models
                    const models = await fetchAvailableModels();
                    let modelMsg = "";
                    if (models && models.length > 0) {
                        populateModelDropdown(models);
                        modelMsg = ` | ${models.length} models loaded`;
                    }

                    showValidationStatus(`Valid key!${balanceMsg}${modelMsg}`, "success");
                } else {
                    showValidationStatus(result.error || "Invalid API key", "error");
                }
            } catch (err) {
                showValidationStatus("Error during validation: " + (err.message || "Unknown error"), "error");
            } finally {
                validateKeyBtn.disabled = false;
                validateKeyBtn.classList.remove("validating");
                validateKeyBtn.textContent = "Validate";
            }
        });
    }

    // Check Balance button


    // Refresh usage button
    const refreshUsageBtn = document.getElementById("refreshUsageBtn");
    if (refreshUsageBtn) {
        refreshUsageBtn.addEventListener("click", () => {
            refreshUsageDisplay();
        });
    }

    // Save button (kept as fallback; hidden in UI)
    const saveButton = document.getElementById("saveButton");
    if (saveButton) {
        saveButton.addEventListener("click", async () => {
            const newSettings = getSettingsFromUI();
            try {
                if (!haveSettingsChanged(lastSavedSettings, newSettings)) {
                    disableSaveButton();
                    return;
                }

                await saveSettings(newSettings);
                lastSavedSettings = { ...newSettings };
                showSuccessPrompt();
                disableSaveButton();
            } catch (err) {
                error("Failed to save settings:", err);
                showErrorPrompt(
                    "Error saving settings: " +
                    (err?.message || "Unknown error")
                );
            }
        });
    }
    // Close prompt button
    if (promptClose) {
        promptClose.addEventListener("click", () => {
            hideSuccessPrompt();
        });
    }
}

// Show validation status message
function showValidationStatus(message, type) {
    const statusEl = document.getElementById("keyValidationStatus");
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = "validation-status " + type;
    }
}

// Refresh usage display
async function refreshUsageDisplay() {
    const refreshBtn = document.getElementById("refreshUsageBtn");
    if (refreshBtn) {
        refreshBtn.classList.add("refreshing");
    }

    const usage = await fetchUsageStats();

    if (refreshBtn) {
        refreshBtn.classList.remove("refreshing");
    }

    updateUsageDisplay(usage);
}

// Update usage display with fetched data
function updateUsageDisplay(usage) {
    const requestCount = document.getElementById("requestCount");
    const requestLimit = document.getElementById("requestLimit");
    const resetTime = document.getElementById("resetTime");

    if (!usage) {
        if (requestCount) requestCount.textContent = "0";
        if (resetTime) resetTime.textContent = "~24h";
        updateLimitLabels(null);
        return;
    }

    const requestProgress = document.getElementById("requestProgress");

    if (usage.isByok) {
        // BYOK mode - usage stats not shown
        return;
    }

    // Update request stats
    if (requestCount) requestCount.textContent = formatNumber(usage.dayRequests);
    if (requestLimit) requestLimit.textContent = formatNumber(usage.dayLimit);
    if (requestProgress) {
        const requestPercent = Math.min(100, (usage.dayRequests / usage.dayLimit) * 100);
        requestProgress.style.width = requestPercent + "%";
        requestProgress.className = "usage-progress-bar";
        if (requestPercent >= 90) requestProgress.classList.add("danger");
        else if (requestPercent >= 70) requestProgress.classList.add("warning");
    }

    // Update reset time
    if (resetTime) {
        resetTime.textContent = formatTimeRemaining(usage.resetsAt);
    }

    // Also update labels if they differ (proxy is source of truth)
    updateLimitLabels(usage.dayLimit);
}

// Disable save button (stub - button is hidden, autosave is used)
function disableSaveButton() {
    const saveButton = document.getElementById("saveButton");
    if (saveButton) {
        saveButton.disabled = true;
    }
}

// Show success prompt
function showSuccessPrompt() {
    const prompt = document.getElementById("savePrompt");
    if (!prompt) return;
    const title = prompt.querySelector(".prompt-title");
    if (title) title.textContent = "Preferences saved successfully";
    prompt.classList.remove("hidden", "toast-error");
    prompt.classList.add("toast-success");

    // Auto-hide after 2 seconds
    setTimeout(() => {
        hideSuccessPrompt();
    }, 2000);
}

// Hide success prompt
function hideSuccessPrompt() {
    const prompt = document.getElementById("savePrompt");
    if (!prompt) return;
    const promptClasses = prompt.classList;
    // Use add/remove to be safe
    promptClasses.add("hidden");
}

// Show error prompt (reuses the same banner area)
function showErrorPrompt(message) {
    const prompt = document.getElementById("savePrompt");
    if (!prompt) return;
    const title = prompt.querySelector(".prompt-title");
    if (title) title.textContent = message;
    prompt.classList.remove("hidden", "toast-success");
    prompt.classList.add("toast-error");

    // Auto-hide after 3 seconds
    setTimeout(() => {
        hideSuccessPrompt();
    }, 3000);
}

// Debounced autosave handler
let autosaveTimerId = null;
// Respect chrome.storage.sync quotas (max 2 writes per second per key)
const AUTOSAVE_DELAY_MS = 1200;

// Debounced model save handler
let modelSaveTimerId = null;

function scheduleModelSave() {
    if (modelSaveTimerId) {
        clearTimeout(modelSaveTimerId);
    }
    modelSaveTimerId = setTimeout(async () => {
        const modelSelect = document.getElementById("modelSelect");
        const userModel = modelSelect?.value || null;
        try {
            if (userModel) {
                await chrome.storage.local.set({ userModel });
            } else {
                await chrome.storage.local.remove("userModel");
            }
        } catch (err) {
            error("Error saving model:", err);
        }
        modelSaveTimerId = null;
    }, 500);
}

function haveSettingsChanged(prev, next) {
    try {
        return JSON.stringify(prev) !== JSON.stringify(next);
    } catch (_) {
        return true;
    }
}

function scheduleAutosave() {
    if (autosaveTimerId) {
        clearTimeout(autosaveTimerId);
    }
    autosaveTimerId = setTimeout(async () => {
        const newSettings = getSettingsFromUI();
        if (!haveSettingsChanged(lastSavedSettings, newSettings)) {
            return; // No-op if nothing changed
        }
        try {
            await saveSettings(newSettings);
            lastSavedSettings = { ...newSettings };
            showSuccessPrompt();
        } catch (err) {
            showErrorPrompt(
                "Error saving settings: " + (err?.message || "Unknown error")
            );
        }
        autosaveTimerId = null;
    }, AUTOSAVE_DELAY_MS);
}

// Handle URL parameters for deep linking
function handleUrlParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    const section = urlParams.get("section");

    if (section === "api") {
        // Scroll to API settings section and highlight it
        const apiSettings = document.getElementById("apiSettings");

        if (apiSettings) {
            // Give the page time to render fully
            setTimeout(() => {
                apiSettings.scrollIntoView({ behavior: "smooth", block: "start" });

                // Add highlight effect
                apiSettings.classList.add("highlight");

                // Remove highlight after animation completes
                setTimeout(() => {
                    apiSettings.classList.remove("highlight");
                }, 2000);
            }, 100);
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
    initSettingsPage();
    handleUrlParameters();
});
