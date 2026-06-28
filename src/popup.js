import { openCalendarEventsInBackground } from "./background/openCalendar.js";
import { DEBUG } from "../config.js";
import { escapeHtml } from "./utils/string.js";
import { applyTheme } from "./ui/theme.js";
import { debug, warn, error } from "./utils/logger.js";
import { buildModelInput } from "./llm/preprocess.js";
import { preprocessForPopup } from "./utils/scan.js";
import { getRequiredTabScanBlockReason, isTabScanAccessError } from "./utils/tabAccess.js";
import {
    CARD_FADE_DURATION_MS,
    CARD_STAGGER_DELAY_MS,
    HIGHLIGHT_RESULTS_KEY,
    IDLE_STATE_CLEANUP_DELAY_MS,
    IMAGE_RESULTS_KEY,
    KEY_CUSTOM_FILES,
    KEY_CUSTOM_TEXT,
    KEY_CUSTOM_VIEW_ACTIVE,
    RESULTS_BUTTON_APPEAR_DELAY_MS,
    SCAN_AVAILABILITY_CHECKING_MESSAGE,
    SKELETON_APPEARANCE_STAGGER_MS,
    SKELETON_FADE_DURATION_MS,
    SKELETON_STAGGER_DELAY_MS,
    UI_STATE,
} from "./popup/constants.js";
import { loadCache, saveCache } from "./popup/cacheStore.js";
import {
    formatDateTime as formatPopupDateTime,
    isEventPast as isPopupEventPast,
} from "./popup/dateTime.js";
import {
    createEventCard,
    renderEventLists,
    restoreSelection as restoreEventSelection,
    scrollToCard,
} from "./popup/eventCards.js";
import { createScanPoller } from "./popup/scanPolling.js";
import { createPopupSettingsStore } from "./popup/settingsStore.js";
import { captureActiveTabHtml, getActiveTab } from "./popup/tabCapture.js";
import { hideToast, showToast } from "./popup/toast.js";

const scanBtn = document.getElementById("scanBtn");
const upcomingEventsListEl = document.getElementById("upcomingEventsList");
const pastEventsListEl = document.getElementById("pastEventsList");
const resultsEl = document.getElementById("results");
const addSelectedBtn = document.getElementById("addSelectedBtn");

const settingsBtn = document.getElementById("settingsBtn");
const customContextBtn = document.getElementById("customContextBtn");
const customContextSection = document.getElementById("customContextSection");
const scanSection = document.getElementById("scanSection");
const customInput = document.getElementById("customInput");
const scanMediaBtn = document.getElementById("scanMediaBtn");

const popupSettingsStore = createPopupSettingsStore();
const ensureSettingsLoaded = popupSettingsStore.ensureSettingsLoaded;
const getTimeFormatPreference = popupSettingsStore.getTimeFormatPreference;

// Kick off settings load early to minimize race conditions for UI rendering
ensureSettingsLoaded();

// Restore persistent state
async function restoreCustomContextState() {
    try {
        const result = await chrome.storage.local.get([
            KEY_CUSTOM_VIEW_ACTIVE,
            KEY_CUSTOM_TEXT,
            KEY_CUSTOM_FILES
        ]);

        if (result[KEY_CUSTOM_VIEW_ACTIVE]) {
            customContextSection?.classList.remove("hidden");
            scanSection?.classList.add("hidden");
            resultsEl?.classList.remove("open", "has-results");
        }

        if (result[KEY_CUSTOM_TEXT] && customInput) {
            customInput.value = result[KEY_CUSTOM_TEXT];
        }

        if (result[KEY_CUSTOM_FILES] && Array.isArray(result[KEY_CUSTOM_FILES])) {
            // Rehydrate files from base64
            // For preview purposes, we can use the base64 string directly as src
            // For sending, we can also use them directly since we already use base64 for transport

            // We need to reconstruct currentImageFiles for the logic to work
            // Since we can't easily turn base64 back to File objects with original names/types accurately without storing metadata,
            // we will store them as objects { base64, type, name } if possible, or just accept base64 strings in our internal array.

            // Let's assume currentImageFiles can handle objects or strings.
            // But existing logic uses URL.createObjectURL(file).
            // We need to adapt updateImageUI to handle { type: 'base64', data: ... }

            currentImageFiles = result[KEY_CUSTOM_FILES].map(item => {
                // If it's a simple string (legacy or simple save), wrap it
                if (typeof item === 'string') return { data: item, type: 'image/png' }; // fallback
                return item;
            });
            updateImageUI();
        }
    } catch (e) {
        console.error("Failed to restore state", e);
    }
}

// Call restore
restoreCustomContextState();

let currentState = UI_STATE.IDLE;
let stateCleanupTimeout = null; // Track cleanup timeout to prevent race conditions
let currentScanBlockReason = null;
let scanAvailabilityReady = false;

function applyScanButtonAvailability() {
    if (!scanBtn) return;

    const reason = currentScanBlockReason;
    const isUnavailable = Boolean(reason);
    const isChecking = !scanAvailabilityReady;
    const isBusy = currentState === UI_STATE.SCANNING;
    const title = isUnavailable
        ? reason
        : isChecking
            ? SCAN_AVAILABILITY_CHECKING_MESSAGE
            : "Scan Page";

    scanBtn.disabled = isBusy || isUnavailable || isChecking;
    scanBtn.title = title;
    scanBtn.classList.toggle("scan-unavailable", isUnavailable || isChecking);
    scanSection?.classList.toggle("scan-unavailable", isUnavailable || isChecking);
    if (scanSection) {
        scanSection.title = isUnavailable || isChecking ? title : "";
    }
}

function setScanAvailabilityReason(reason) {
    scanAvailabilityReady = true;
    currentScanBlockReason = reason || null;
    applyScanButtonAvailability();
    if (currentScanBlockReason) {
        hideToast();
    }
}

async function refreshScanAvailability(activeTab = null) {
    let reason = null;

    scanAvailabilityReady = false;
    applyScanButtonAvailability();

    try {
        const tab = activeTab || await getActiveTab();
        reason = getRequiredTabScanBlockReason(tab?.url);
    } catch (err) {
        DEBUG && debug("[Eventy][Popup] Failed to check scan availability:", err);
        reason = "This page cannot be scanned.";
    }

    setScanAvailabilityReason(reason);
    return reason;
}

/**
 * Transition to scanning state
 * Shows skeleton cards and smoothly expands the container
 */
function transitionToScanning() {
    scanBtn.disabled = true;

    // Check if we have existing event cards to fade out
    const existingCards = resultsEl?.querySelectorAll(".event-card");
    const hasExistingCards = existingCards && existingCards.length > 0;

    // Remove has-results to hide button smoothly
    resultsEl?.classList.remove("has-results");
    resultsEl?.classList.add("open", "scanning");
    scanBtn?.classList.add("scanning");

    if (hasExistingCards) {
        // Fade out existing cards
        existingCards.forEach((card, i) => {
            setTimeout(() => {
                card.style.transition =
                    `opacity ${CARD_FADE_DURATION_MS}ms ease, transform ${CARD_FADE_DURATION_MS}ms ease`;
                card.style.opacity = "0";
                card.style.transform = "scale(0.95)";
            }, i * CARD_STAGGER_DELAY_MS);
        });

        // Wait for fade out, then show skeletons
        setTimeout(() => {
            if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
            if (pastEventsListEl) pastEventsListEl.innerHTML = "";
            showSkeletonCards();
        }, CARD_FADE_DURATION_MS + existingCards.length * CARD_STAGGER_DELAY_MS);
    } else {
        // No existing cards, just show skeletons
        if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
        if (pastEventsListEl) pastEventsListEl.innerHTML = "";
        requestAnimationFrame(() => {
            showSkeletonCards();
        });
    }
}

/**
 * Central state setter - updates all UI elements based on new state
 */
function setState(newState) {
    if (currentState === newState) return;

    DEBUG && debug(`[Eventy][UI] State transition: ${currentState} -> ${newState}`);

    // Clear any pending cleanup timeout to prevent race conditions
    if (stateCleanupTimeout) {
        clearTimeout(stateCleanupTimeout);
        stateCleanupTimeout = null;
    }

    currentState = newState;

    switch (newState) {
        case UI_STATE.IDLE:
            // Smoothly collapse everything back to initial state
            resultsEl?.classList.remove("open", "scanning", "has-results", "quota-exceeded");
            scanBtn?.classList.remove("scanning");
            applyScanButtonAvailability();

            // Hide quota panel
            const quotaPanelIdle = document.getElementById("quotaExceeded");
            quotaPanelIdle?.classList.add("hidden");

            // Clear content after animation, but only if state hasn't changed
            // Capture the state at timeout creation to avoid race conditions
            const targetState = newState;
            stateCleanupTimeout = setTimeout(() => {
                if (currentState === targetState) {
                    if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
                    if (pastEventsListEl) pastEventsListEl.innerHTML = "";
                }
                stateCleanupTimeout = null;
            }, IDLE_STATE_CLEANUP_DELAY_MS);
            break;

        case UI_STATE.SCANNING:
            transitionToScanning();
            break;

        case UI_STATE.RESULTS_LOADED:
            // Transition from scanning to results
            resultsEl?.classList.add("open");
            resultsEl?.classList.remove("scanning", "quota-exceeded");
            scanBtn?.classList.remove("scanning");
            applyScanButtonAvailability();

            // Hide quota panel if visible
            const quotaPanelResults = document.getElementById("quotaExceeded");
            quotaPanelResults?.classList.add("hidden");

            // Add has-results class to show the button with animation
            // Small delay to ensure smooth transition
            setTimeout(() => {
                resultsEl?.classList.add("has-results");
            }, RESULTS_BUTTON_APPEAR_DELAY_MS);
            break;

        case UI_STATE.QUOTA_EXCEEDED:
            // Show quota exceeded panel
            resultsEl?.classList.add("open", "quota-exceeded");
            resultsEl?.classList.remove("scanning", "has-results");
            scanBtn?.classList.remove("scanning");
            applyScanButtonAvailability();

            // Clear any skeleton cards
            if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
            if (pastEventsListEl) pastEventsListEl.innerHTML = "";

            // Show quota exceeded panel
            const quotaPanel = document.getElementById("quotaExceeded");
            quotaPanel?.classList.remove("hidden");
            break;
    }
}

// Load and apply theme on popup load
async function loadAndApplyTheme() {
    try {
        const settings = await ensureSettingsLoaded();
        const theme = settings.darkModeSettings || "auto";
        applyTheme(theme);
    } catch (err) {
        error("Error loading theme:", err);
        applyTheme("auto");
    }
}

// Theme initialization happens during popup bootstrap (see initializePopup)

function waitForDocumentReady() {
    if (document.readyState === "loading") {
        return new Promise((resolve) => {
            document.addEventListener("DOMContentLoaded", resolve, {
                once: true,
            });
        });
    }
    return Promise.resolve();
}

const themeReadyPromise = (async () => {
    await waitForDocumentReady();
    const body = document.body;
    if (body && !body.classList.contains("auto-mode")) {
        body.classList.add("theme-loading");
    }
    try {
        await loadAndApplyTheme();
    } finally {
        if (body) {
            body.classList.remove("theme-loading");
        }
    }
})();

function isEventPast(event) {
    return isPopupEventPast(event, { warn, error });
}

function formatDateTime(dateStr, timeStr) {
    return formatPopupDateTime(dateStr, timeStr, getTimeFormatPreference());
}

// Helper to create skeleton loading cards
function showSkeletonCards(count = 3) {
    if (!upcomingEventsListEl) return;
    upcomingEventsListEl.innerHTML = "";
    for (let i = 0; i < count; i++) {
        const skeleton = document.createElement("div");
        skeleton.className = "skeleton-card";
        // Stagger animation for cascading effect
        skeleton.style.animationDelay = `${i * SKELETON_APPEARANCE_STAGGER_MS}ms`;
        skeleton.innerHTML = `
            <div class="skeleton-content">
                <div class="skeleton-line title"></div>
                <div class="skeleton-bottom">
                    <div class="skeleton-times">
                        <div class="skeleton-line time"></div>
                        <div class="skeleton-line time"></div>
                    </div>
                    <div class="skeleton-line location"></div>
                </div>
            </div>
        `;
        upcomingEventsListEl.appendChild(skeleton);
    }
}

// Ensure Settings button works immediately on popup load
settingsBtn?.addEventListener("click", () => {
    try {
        const url = chrome.runtime.getURL("src/ui/settings.html");
        chrome.tabs.create({ url });
    } catch (_) { }
});

// Quota exceeded panel - link to settings with BYOK section
const quotaSettingsBtn = document.getElementById("quotaSettingsBtn");
quotaSettingsBtn?.addEventListener("click", () => {
    try {
        const url = chrome.runtime.getURL("src/ui/settings.html") + "?section=api";
        chrome.tabs.create({ url });
    } catch (_) { }
});

// Clean up timeouts when popup closes
window.addEventListener("unload", () => {
    scanPoller.clearAll();

    // Clear state cleanup timeout
    if (stateCleanupTimeout) {
        clearTimeout(stateCleanupTimeout);
        stateCleanupTimeout = null;
    }
});

// Update button states based on selection
function updateButtonStates() {
    const selectedCards = resultsEl?.querySelectorAll(".event-card.selected");
    const selectionCount = selectedCards ? selectedCards.length : 0;
    const hasSelection = selectionCount > 0;

    if (addSelectedBtn) {
        addSelectedBtn.disabled = !hasSelection;

    }
}

async function handleScan() {
    try {
        const tab = await getActiveTab();
        const blockReason = await refreshScanAvailability(tab);
        if (blockReason) {
            return;
        }

        setState(UI_STATE.SCANNING);
        const { html, text, title, lang, url } = await captureActiveTabHtml(tab);

        // Clear any existing poll timeout for this URL before starting new scan
        scanPoller.clearForUrl(url);

        DEBUG && debug("[Eventy][Popup] Scan started", { url });

        // Preprocess in popup to avoid DOMParser issues in the service worker.
        const { modelHtml, csvSnippets } = preprocessForPopup(text || "", html || "");

        const response = await chrome.runtime.sendMessage({
            action: "scanPage",
            modelInput: modelHtml,
            csvSnippets,
            html, // Required for background fallback
            text, // Keep text just in case, or for title context?
            title,
            lang,
            url,
            imageUrls: [],
        });

        if (!response?.success) {
            const errorMsg = response?.error || "Unknown error";
            error("Scan failed:", errorMsg);

            // Check if this is a rate limit / quota exceeded error
            if (response?.errorType === "RATE_LIMIT" ||
                errorMsg.toLowerCase().includes("rate limit") ||
                errorMsg.toLowerCase().includes("quota") ||
                errorMsg.toLowerCase().includes("daily limit")) {
                setState(UI_STATE.QUOTA_EXCEEDED);
                return;
            }

            // Clean up UI state for other errors
            setState(UI_STATE.IDLE);

            // Then disable button to force refresh/retry if needed (or just show error)
            if (scanBtn) {
                scanBtn.disabled = true;
            }
            return;
        }

        const events = response.events || [];
        if (!events.length) {
            error("No events found on this page");
            // Silent failure
            setState(UI_STATE.IDLE);
            return;
        }

        transitionFromSkeletonsToResults(events);
        await saveCache(url, events, []);

        // Inject event markers on the page (full page scan only)
        if (tab?.id && events.length > 0) {
            try {
                // Check if page markers are enabled in settings
                const settings = await ensureSettingsLoaded();
                if (settings.showPageMarkers === true) {
                    await chrome.runtime.sendMessage({
                        action: "injectEventMarkers",
                        tabId: tab.id,
                        events: events
                    });
                }
            } catch (markerErr) {
                // Silently fail - markers are not critical
                DEBUG && debug("[Eventy][Popup] Failed to inject markers:", markerErr);
            }
        }
    } catch (e) {
        error(e);
        const errorStr = e.message || String(e);

        if (isTabScanAccessError(e)) {
            setState(UI_STATE.IDLE);
            setScanAvailabilityReason(e.userMessage || e.message);
            return;
        }

        // Check if this is a rate limit error
        if (e.name === "RateLimitError" ||
            errorStr.toLowerCase().includes("rate limit") ||
            errorStr.toLowerCase().includes("quota") ||
            errorStr.toLowerCase().includes("daily limit")) {
            setState(UI_STATE.QUOTA_EXCEEDED);
            return;
        }

        // Silent error handling for other errors - disable button instead of showing toast
        setState(UI_STATE.IDLE);
        setScanAvailabilityReason("An error occurred. Please refresh the page.");
    }
}

async function renderEvents(events) {
    await ensureSettingsLoaded();

    // Store events globally for event handlers
    currentEvents = events;

    await renderEventLists(events, {
        upcomingEventsListEl,
        pastEventsListEl,
        isEventPast,
        createCard: (ev, idx) => createEventCard(ev, idx, {
            escapeHtml,
            formatDateTime,
            onToggle: () => {
                updateButtonStates();
                persistSelection(currentEvents);
            },
        }),
        updateButtonStates,
    });
}

/**
 * Transition from skeleton cards to event cards
 * Smoothly fades out skeletons, renders event cards, then shows button
 */
function transitionFromSkeletonsToResults(events) {
    if (!upcomingEventsListEl) return;

    // Fade out skeleton cards
    const skeletons = upcomingEventsListEl.querySelectorAll(".skeleton-card");
    skeletons.forEach((skeleton, i) => {
        setTimeout(() => {
            skeleton.style.transition =
                `opacity ${SKELETON_FADE_DURATION_MS}ms ease, transform ${SKELETON_FADE_DURATION_MS}ms ease`;
            skeleton.style.opacity = "0";
            skeleton.style.transform = "scale(0.95)";
        }, i * SKELETON_STAGGER_DELAY_MS);
    });

    // Wait for fade out, then render event cards
    setTimeout(async () => {
        try {
            upcomingEventsListEl.innerHTML = "";
            if (pastEventsListEl) pastEventsListEl.innerHTML = "";
            await renderEvents(events);

            // Transition to results loaded state
            // This removes 'scanning' class and adds 'has-results'
            // Button appears smoothly via CSS transitions
            setState(UI_STATE.RESULTS_LOADED);
        } catch (e) {
            error("Failed to render events:", e);
            setState(UI_STATE.IDLE);
        }
    }, SKELETON_FADE_DURATION_MS + skeletons.length * SKELETON_STAGGER_DELAY_MS);
}

function persistSelection(events) {
    const cards = resultsEl?.querySelectorAll(".event-card");
    const selectedIdxs = [];
    if (cards) {
        cards.forEach((el) => {
            const i = Number(el.getAttribute("data-idx"));
            if (!Number.isNaN(i) && el.classList.contains("selected")) {
                selectedIdxs.push(i);
            }
        });
    }
    (async () => {
        const tab = await getActiveTab();
        const url = tab?.url || "";
        await saveCache(url, events || currentEvents, selectedIdxs);
    })();
}

let currentEvents = [];
const scanPoller = createScanPoller({
    warn,
    error,
    onQuotaExceeded: () => setState(UI_STATE.QUOTA_EXCEEDED),
});
const pollForResults = scanPoller.pollForResults;

// Helper to restore selected event indices
function restoreSelection(selectedIdxs) {
    const firstSelected = restoreEventSelection(selectedIdxs, {
        resultsEl,
        updateButtonStates,
    });

    if (firstSelected) {
        scrollToCard(firstSelected);
    }
}

scanBtn?.addEventListener("click", handleScan);
refreshScanAvailability();

// Helper to save current state
async function saveCustomState() {
    try {
        const isCustomOpen = !customContextSection.classList.contains("hidden");
        const text = customInput?.value || "";

        // Files are saved separately when they change because processing them takes time
        await chrome.storage.local.set({
            [KEY_CUSTOM_VIEW_ACTIVE]: isCustomOpen,
            [KEY_CUSTOM_TEXT]: text
        });
    } catch (_) { }
}

async function saveCustomFiles() {
    try {
        // Convert all current files to base64 for storage
        // If already base64 object, keep it. If File/Blob, convert.
        const serializedFiles = await Promise.all(currentImageFiles.map(async (file) => {
            if (file.data) return file; // Already serialized
            const base64 = await fileToBase64(file);
            return { data: base64, type: file.type, name: file.name };
        }));

        await chrome.storage.local.set({
            [KEY_CUSTOM_FILES]: serializedFiles
        });
    } catch (e) {
        console.error("Error saving files", e);
    }
}

customContextBtn?.addEventListener("click", () => {
    const isHidden = customContextSection.classList.contains("hidden");
    if (isHidden) {
        customContextSection.classList.remove("hidden");
        scanSection.classList.add("hidden");
        resultsEl.classList.remove("open", "has-results");
        customInput.focus();
    } else {
        customContextSection.classList.add("hidden");
        scanSection.classList.remove("hidden");
        refreshScanAvailability();
    }
    saveCustomState();
});

const mediaInput = document.getElementById("mediaInput");
const imagePreviewContainer = document.getElementById("imagePreviewContainer");

let currentImageFiles = [];

function updateImageUI() {
    // UpdatePreviews
    if (imagePreviewContainer) {
        imagePreviewContainer.innerHTML = "";
        currentImageFiles.forEach((file, index) => {
            const item = document.createElement("div");
            item.className = "image-preview-item";

            const img = document.createElement("img");
            img.className = "image-preview-img";

            // Handle both File objects (new uploads) and persisted objects { data: base64 }
            if (file.data) {
                img.src = file.data;
            } else {
                img.src = URL.createObjectURL(file);
                img.onload = () => URL.revokeObjectURL(img.src); // Cleanup
            }

            const removeBtn = document.createElement("button");
            removeBtn.className = "image-remove-btn";
            removeBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                currentImageFiles.splice(index, 1);
                // Update persistent storage
                saveCustomFiles();
                updateImageUI();
            };

            item.appendChild(img);
            item.appendChild(removeBtn);
            imagePreviewContainer.appendChild(item);
        });
    }
}

mediaInput?.addEventListener("change", async () => {
    if (mediaInput.files) {
        // Replace current files with new selection from input
        const newFiles = Array.from(mediaInput.files);
        // We replace or append? Typically file input replaces unless we handle merge.
        // User probably expects replace if clicking "choose files", or append?
        // Let's stick to existing behavior (replace) but maybe append is better for "Add Photos"?
        // Existing: currentImageFiles = Array.from(mediaInput.files);
        // Let's keep it replace for now, but immediately save.

        currentImageFiles = newFiles;
        updateImageUI();
        await saveCustomFiles();
        // Also save view state just in case
        saveCustomState();
    }
});

// Handle paste events on the textarea
customInput?.addEventListener("input", saveCustomState); // Save text on input
customInput?.addEventListener("paste", async (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    let hasImages = false;

    for (const item of items) {
        if (item.type.indexOf("image") === 0) {
            const blob = item.getAsFile();
            if (blob) {
                currentImageFiles.push(blob);
                hasImages = true;
            }
        }
    }

    if (hasImages) {
        updateImageUI();
        await saveCustomFiles();
    }
});

// Helper to convert file to base64
const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
    });
};

scanMediaBtn?.addEventListener("click", async () => {
    const text = customInput.value.trim();
    const files = currentImageFiles;

    if (!text && (!files || files.length === 0)) return;

    try {
        setState(UI_STATE.SCANNING);
        // PERSISTENCE: Do NOT hide custom input section during scan
        // customContextSection.classList.add("hidden");

        // Process images if any
        const imageUrls = [];
        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                try {
                    const file = files[i];
                    // If already base64 object (persisted), use it directly
                    if (file.data) {
                        imageUrls.push(file.data);
                    } else {
                        // Otherwise convert (newly added File/Blob)
                        const base64 = await fileToBase64(file);
                        imageUrls.push(base64);
                    }
                } catch (err) {
                    error("Failed to process image:", err);
                }
            }
        }

        // Use current tab URL for cache key if possible, or a generic one
        const tab = await getActiveTab();
        const url = tab?.url || "custom-context-scan";

        // Preprocess custom text to apply context compression and token limits
        // Pass null for HTML scan so it treats input as raw text (or attempts to parse if it looks like HTML, but mainly for text compression)
        const modelInput = buildModelInput(text, null);

        const response = await chrome.runtime.sendMessage({
            action: "scanPage",
            html: "", // No HTML for custom context scan
            modelInput, // precomputed compressed input
            text: text,
            title: "Custom Context",
            lang: "en", // Default to en
            url: url,
            imageUrls: imageUrls,
            cacheResults: false,
        });

        if (!response?.success) {
            const errorMsg = response?.error || "Unknown error";
            error("Scan failed:", errorMsg);

            // Check if this is a rate limit / quota exceeded error
            if (response?.errorType === "RATE_LIMIT" ||
                errorMsg.toLowerCase().includes("rate limit") ||
                errorMsg.toLowerCase().includes("quota") ||
                errorMsg.toLowerCase().includes("daily limit")) {
                setState(UI_STATE.QUOTA_EXCEEDED);
                return;
            }

            showToast(errorMsg, "error");
            setState(UI_STATE.IDLE);
            return;
        }

        const events = response.events || [];
        if (!events.length) {
            console.log("No events found");
            setState(UI_STATE.IDLE);
            // customContextSection.classList.remove("hidden"); // Already visible
            return;
        }

        transitionFromSkeletonsToResults(events);
        // Don't cache custom scans for now, or use a specific key
    } catch (e) {
        error(e);
        const errorStr = e.message || String(e);

        // Check if this is a rate limit error
        if (e.name === "RateLimitError" ||
            errorStr.toLowerCase().includes("rate limit") ||
            errorStr.toLowerCase().includes("quota") ||
            errorStr.toLowerCase().includes("daily limit")) {
            setState(UI_STATE.QUOTA_EXCEEDED);
            return;
        }

        // Provide user-friendly error messages for other cases
        let userMessage = "An unexpected error occurred";

        if (errorStr.includes("network") || errorStr.includes("fetch")) {
            userMessage = "Network error. Check your connection.";
        } else if (errorStr.includes("timeout")) {
            userMessage = "Request timed out";
        }

        showToast(userMessage, "error");
        setState(UI_STATE.IDLE);
    }
});

addSelectedBtn?.addEventListener("click", async () => {
    try {
        const cards = resultsEl?.querySelectorAll(".event-card.selected");
        if (!cards) return;
        const selected = Array.from(cards)
            .map((el) => {
                const i = Number(el.getAttribute("data-idx"));
                return !Number.isNaN(i) ? currentEvents[i] : null;
            })
            .filter(Boolean);
        if (selected.length) await openCalendarEventsInBackground(selected);
    } catch (e) {
        error(e);
    }
});

// Check if a scan is in progress and show skeleton cards while waiting
async function checkForInProgressScan() {
    try {
        const tab = await getActiveTab();
        const url = tab?.url || "";

        // Check if scan is in progress
        const result = await chrome.storage.local.get(`eventy-scanning:${url}`);
        const isScanning = result[`eventy-scanning:${url}`];

        if (!isScanning) {
            return false; // No scan in progress
        }

        // Scan is in progress - transition to scanning state
        setState(UI_STATE.SCANNING);

        pollForResults(
            url,
            null,
            (cached) => {
                if (cached.events.length === 0) {
                    setState(UI_STATE.IDLE);
                } else {
                    transitionFromSkeletonsToResults(cached.events);
                    restoreSelection(cached.selected);
                }
            },
            () => setState(UI_STATE.IDLE),
            { minimumResultTs: isScanning.startTime }
        );

        return true;
    } catch (e) {
        error(e);
        return false;
    }
}

// Helper to ensure scanning animation is showing for deferred results
async function ensureDeferredScanningAnimation() {
    if (currentState !== UI_STATE.SCANNING) {
        setState(UI_STATE.SCANNING);
        // Give UI a moment to update
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
}

// Helper to display deferred results
function displayDeferredResults(events) {
    if (!events || events.length === 0) {
        setState(UI_STATE.IDLE);
        return false;
    }
    transitionFromSkeletonsToResults(events);
    return true;
}

async function tryLoadDeferredResults(storageKey) {
    try {
        const result = await chrome.storage.local.get(storageKey);
        const stored = result[storageKey];
        if (!stored) {
            return false;
        }

        if (stored.status === "scanning") {
            await ensureDeferredScanningAnimation();
            pollForResults(
                null,
                storageKey,
                (stored) => displayDeferredResults(stored.events),
                () => setState(UI_STATE.IDLE)
            );
            return true;
        }

        if (stored.status === "complete") {
            await chrome.storage.local.remove(storageKey);
            return await displayDeferredResults(stored.events);
        }

        if (stored.status === "error") {
            await chrome.storage.local.remove(storageKey);
            // Check if this is a rate limit error
            if (stored.errorType === "RATE_LIMIT" ||
                (stored.error && (
                    stored.error.toLowerCase().includes("rate limit") ||
                    stored.error.toLowerCase().includes("quota") ||
                    stored.error.toLowerCase().includes("daily limit")
                ))) {
                setState(UI_STATE.QUOTA_EXCEEDED);
            } else {
                setState(UI_STATE.IDLE);
            }
            return true;
        }

        return false;
    } catch (e) {
        error(e);
        return false;
    }
}

// Helper to select a specific event and scroll it into view
function selectAndScrollToEvent(eventIndex) {
    const card = resultsEl?.querySelector(`.event-card[data-idx="${eventIndex}"]`);
    if (!card) return;

    // Clear existing selection
    const allCards = resultsEl?.querySelectorAll(".event-card");
    allCards?.forEach(c => c.classList.remove("selected"));

    // Select the target card
    card.classList.add("selected");

    // Scroll to the card
    scrollToCard(card);

    updateButtonStates();
    persistSelection(currentEvents);
}

// Check for pending event selection from marker click
async function checkPendingEventSelection() {
    try {
        const result = await chrome.storage.local.get("eventy-pending-selection");
        const pending = result["eventy-pending-selection"];

        if (!pending) return null;

        // Clear the pending selection
        await chrome.storage.local.remove("eventy-pending-selection");

        // Check if the selection is still fresh (within 5 seconds)
        if (Date.now() - pending.ts > 5000) return null;

        // Check if the URL matches the current tab
        const tab = await getActiveTab();
        if (pending.tabUrl && tab?.url !== pending.tabUrl) return null;

        return pending.eventIndex;
    } catch (e) {
        error("Error checking pending selection:", e);
        return null;
    }
}

(async function restoreFromCache() {
    try {
        // Check for pending event selection from marker click first
        const pendingEventIndex = await checkPendingEventSelection();

        if (await tryLoadDeferredResults(HIGHLIGHT_RESULTS_KEY)) {
            return;
        }

        if (await tryLoadDeferredResults(IMAGE_RESULTS_KEY)) {
            return;
        }

        const tab = await getActiveTab();
        const url = tab?.url || "";

        // Check if scan is in progress first
        const hasInProgressScan = await checkForInProgressScan();
        if (hasInProgressScan) {
            return; // Waiting for in-progress scan
        }

        // No scan in progress, load cached results
        const cached = await loadCache(url);
        if (!cached || !cached.events || !cached.events.length) {
            setState(UI_STATE.IDLE);
            return;
        }

        // Smoothly transition to showing cached results
        // First set to open state without results
        resultsEl?.classList.add("open");

        // Render the events
        await renderEvents(cached.events);

        // Then transition to results state with button
        requestAnimationFrame(() => {
            setState(UI_STATE.RESULTS_LOADED);

            // If we have a pending event selection from marker click, use that
            if (pendingEventIndex !== null && pendingEventIndex !== undefined) {
                selectAndScrollToEvent(pendingEventIndex);
            } else {
                restoreSelection(cached.selected);
            }
        });
    } catch (e) {
        error(e);
        setState(UI_STATE.IDLE);
    }
})();
