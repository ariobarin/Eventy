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
    SKELETON_FADE_DURATION_MS,
    SKELETON_STAGGER_DELAY_MS,
    UI_STATE,
} from "./popup/constants.js";
import { loadCache, saveCache } from "./popup/cacheStore.js";
import {
    formatTimeOnly as formatPopupTimeOnly,
    isEventPast as isPopupEventPast,
} from "./popup/dateTime.js";
import {
    createEventCard,
    renderEventLists,
    restoreSelection as restoreEventSelection,
    scrollToCard,
    resetColorIndex,
} from "./popup/eventCards.js";
import { createScanPoller } from "./popup/scanPolling.js";
import { createPopupSettingsStore } from "./popup/settingsStore.js";
import { captureActiveTabHtml, getActiveTab } from "./popup/tabCapture.js";
import { hideToast, showToast } from "./popup/toast.js";

// ===========================================
// DOM elements
// ===========================================
const scanBtn = document.getElementById("scanBtn");
const upcomingEventsListEl = document.getElementById("upcomingEventsList");
const pastEventsListEl = document.getElementById("pastEventsList");
const resultsEl = document.getElementById("results");
const addSelectedBtn = document.getElementById("addSelectedBtn");

const settingsBtn = document.getElementById("settingsBtn");
const customContextBtn = document.getElementById("customContextBtn");
const customContextSection = document.getElementById("customContextSection");
const customInput = document.getElementById("customInput");
const scanMediaBtn = document.getElementById("scanMediaBtn");

const tabUpcoming = document.getElementById("tabUpcoming");
const tabPast = document.getElementById("tabPast");
const footerSelectedEl = document.getElementById("footerSelected");
const spiralBindingEl = document.getElementById("spiralBinding");
const ruledListEl = document.getElementById("ruledList");

const popupSettingsStore = createPopupSettingsStore();
const ensureSettingsLoaded = popupSettingsStore.ensureSettingsLoaded;
const getTimeFormatPreference = popupSettingsStore.getTimeFormatPreference;

ensureSettingsLoaded();

// ===========================================
// Generate spiral coils
// ===========================================
function generateSpiral() {
    if (!spiralBindingEl) return;
    for (let i = 0; i < 18; i++) {
        const coil = document.createElement("div");
        coil.className = "coil";
        spiralBindingEl.appendChild(coil);
    }
}
generateSpiral();

// ===========================================
// Restore persistent state
// ===========================================
async function restoreCustomContextState() {
    try {
        const result = await chrome.storage.local.get([
            KEY_CUSTOM_VIEW_ACTIVE,
            KEY_CUSTOM_TEXT,
            KEY_CUSTOM_FILES
        ]);

        if (result[KEY_CUSTOM_VIEW_ACTIVE]) {
            customContextSection?.classList.remove("hidden");
            resultsEl?.classList.remove("open", "has-results");
        }

        if (result[KEY_CUSTOM_TEXT] && customInput) {
            customInput.value = result[KEY_CUSTOM_TEXT];
        }

        if (result[KEY_CUSTOM_FILES] && Array.isArray(result[KEY_CUSTOM_FILES])) {
            currentImageFiles = result[KEY_CUSTOM_FILES].map(item => {
                if (typeof item === 'string') return { data: item, type: 'image/png' };
                return item;
            });
            updateImageUI();
        }
    } catch (e) {
        console.error("Failed to restore state", e);
    }
}

restoreCustomContextState();

let currentState = UI_STATE.IDLE;
let stateCleanupTimeout = null;
let currentScanBlockReason = null;
let scanAvailabilityReady = false;
let activeTab = "upcoming";

// ===========================================
// Scan availability
// ===========================================
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
            : "Scan this page";

    scanBtn.disabled = isBusy || isUnavailable || isChecking;
    scanBtn.title = title;
    scanBtn.classList.toggle("scan-unavailable", isUnavailable || isChecking);
}

function setScanAvailabilityReason(reason) {
    scanAvailabilityReady = true;
    currentScanBlockReason = reason || null;
    applyScanButtonAvailability();
    if (currentScanBlockReason) hideToast();
}

async function refreshScanAvailability(activeTabObj = null) {
    let reason = null;
    scanAvailabilityReady = false;
    applyScanButtonAvailability();

    try {
        const tab = activeTabObj || await getActiveTab();
        reason = getRequiredTabScanBlockReason(tab?.url);
    } catch (err) {
        DEBUG && debug("[Eventy][Popup] Failed to check scan availability:", err);
        reason = "This page cannot be scanned.";
    }

    setScanAvailabilityReason(reason);
    return reason;
}

// ===========================================
// Segmented toggle
// ===========================================
function switchTab(tab) {
    activeTab = tab;
    tabUpcoming?.classList.toggle("active", tab === "upcoming");
    tabPast?.classList.toggle("active", tab === "past");
    upcomingEventsListEl?.classList.toggle("hidden", tab !== "upcoming");
    pastEventsListEl?.classList.toggle("hidden", tab !== "past");
}

tabUpcoming?.addEventListener("click", () => switchTab("upcoming"));
tabPast?.addEventListener("click", () => switchTab("past"));

// ===========================================
// Week strip
// ===========================================
function updateWeekStrip(events) {
    const weekStripEl = document.getElementById("weekStrip");
    if (!weekStripEl) return;
    weekStripEl.innerHTML = "";

    // Find the Monday of the current week
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);

    const dayLetters = ["M", "T", "W", "T", "F", "S", "S"];

    // Build a map of date -> color for events this week
    const dateColorMap = {};
    if (events) {
        const allCards = resultsEl?.querySelectorAll(".event-card");
        if (allCards) {
            allCards.forEach(c => {
                const idx = Number(c.dataset.idx);
                const ev = events[idx];
                if (ev?.startDate && c.dataset.color) {
                    dateColorMap[ev.startDate] = c.dataset.color;
                }
            });
        }
    }

    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const isSunday = d.getDay() === 0;
        const dotColor = dateColorMap[dateStr];

        const col = document.createElement("div");
        col.className = "week-day";
        col.innerHTML = `
            <div class="week-day-letter">${dayLetters[i]}</div>
            <div class="week-day-num${isSunday ? ' sunday' : ''}">${d.getDate()}</div>
            <div class="week-dot-container">${dotColor ? `<div class="week-dot" style="background:${dotColor}"></div>` : ''}</div>
        `;
        weekStripEl.appendChild(col);
    }
}

// ===========================================
// Footer update
// ===========================================
function updateFooterCount() {
    const selectedCards = resultsEl?.querySelectorAll(".event-card.selected");
    const count = selectedCards ? selectedCards.length : 0;
    if (footerSelectedEl) {
        footerSelectedEl.textContent = `${count} selected`;
    }
}

function updateButtonStates() {
    const selectedCards = resultsEl?.querySelectorAll(".event-card.selected");
    const selectionCount = selectedCards ? selectedCards.length : 0;
    const hasSelection = selectionCount > 0;

    if (addSelectedBtn) addSelectedBtn.disabled = !hasSelection;
    updateFooterCount();
}

// ===========================================
// Update toggle labels with counts
// ===========================================
function updateToggleLabels(upcomingCount, pastCount) {
    if (tabUpcoming) tabUpcoming.textContent = `Upcoming · ${upcomingCount}`;
    if (tabPast) tabPast.textContent = `Past · ${pastCount}`;
}

// ===========================================
// State management
// ===========================================
function transitionToScanning() {
    scanBtn?.classList.add("scanning");

    const existingCards = resultsEl?.querySelectorAll(".event-card");
    const hasExistingCards = existingCards && existingCards.length > 0;

    resultsEl?.classList.remove("has-results");
    resultsEl?.classList.add("open", "scanning");

    if (hasExistingCards) {
        const allItems = resultsEl?.querySelectorAll(".event-card") || [];
        allItems.forEach((el, i) => {
            setTimeout(() => {
                el.style.transition = `opacity ${CARD_FADE_DURATION_MS}ms ease, transform ${CARD_FADE_DURATION_MS}ms ease`;
                el.style.opacity = "0";
                el.style.transform = "scale(0.95)";
            }, i * CARD_STAGGER_DELAY_MS);
        });

        setTimeout(() => {
            if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
            if (pastEventsListEl) pastEventsListEl.innerHTML = "";
            showSkeletonCards();
        }, CARD_FADE_DURATION_MS + existingCards.length * CARD_STAGGER_DELAY_MS);
    } else {
        if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
        if (pastEventsListEl) pastEventsListEl.innerHTML = "";
        requestAnimationFrame(() => showSkeletonCards());
    }
}

function setState(newState) {
    if (currentState === newState) return;

    DEBUG && debug(`[Eventy][UI] State transition: ${currentState} -> ${newState}`);

    if (stateCleanupTimeout) {
        clearTimeout(stateCleanupTimeout);
        stateCleanupTimeout = null;
    }

    currentState = newState;

    switch (newState) {
        case UI_STATE.IDLE:
            resultsEl?.classList.remove("open", "scanning", "has-results", "quota-exceeded");
            scanBtn?.classList.remove("scanning");
            applyScanButtonAvailability();

            document.getElementById("quotaExceeded")?.classList.add("hidden");

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
            resultsEl?.classList.add("open");
            resultsEl?.classList.remove("scanning", "quota-exceeded");
            scanBtn?.classList.remove("scanning");
            applyScanButtonAvailability();

            document.getElementById("quotaExceeded")?.classList.add("hidden");

            setTimeout(() => {
                resultsEl?.classList.add("has-results");
            }, RESULTS_BUTTON_APPEAR_DELAY_MS);
            break;

        case UI_STATE.QUOTA_EXCEEDED:
            resultsEl?.classList.add("open", "quota-exceeded");
            resultsEl?.classList.remove("scanning", "has-results");
            scanBtn?.classList.remove("scanning");
            applyScanButtonAvailability();

            if (upcomingEventsListEl) upcomingEventsListEl.innerHTML = "";
            if (pastEventsListEl) pastEventsListEl.innerHTML = "";

            document.getElementById("quotaExceeded")?.classList.remove("hidden");
            break;
    }
}

// ===========================================
// Theme
// ===========================================
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

function waitForDocumentReady() {
    if (document.readyState === "loading") {
        return new Promise((resolve) => {
            document.addEventListener("DOMContentLoaded", resolve, { once: true });
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
        if (body) body.classList.remove("theme-loading");
    }
})();

// ===========================================
// Helpers
// ===========================================
function isEventPast(event) {
    return isPopupEventPast(event, { warn, error });
}

function formatTimeOnly(timeStr) {
    return formatPopupTimeOnly(timeStr, getTimeFormatPreference());
}

// ===========================================
// Skeleton cards
// ===========================================
function createSkeletonRow(delay) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.style.animationDelay = `${delay}ms`;
    row.innerHTML = `
        <div class="skeleton-checkbox"></div>
        <div class="skeleton-chip"></div>
        <div class="skeleton-content">
            <div class="skeleton-line title"></div>
            <div class="skeleton-line note"></div>
        </div>
    `;
    return row;
}

function showSkeletonCards() {
    // Show skeletons in whichever list is active
    const targetEl = activeTab === "upcoming" ? upcomingEventsListEl : pastEventsListEl;
    if (!targetEl) return;

    // Also make sure the active list is visible
    upcomingEventsListEl?.classList.toggle("hidden", activeTab !== "upcoming");
    pastEventsListEl?.classList.toggle("hidden", activeTab !== "past");

    targetEl.innerHTML = "";
    for (let i = 0; i < 3; i++) {
        targetEl.appendChild(createSkeletonRow(i * 80));
    }

}

// ===========================================
// Settings & navigation buttons
// ===========================================
settingsBtn?.addEventListener("click", () => {
    try {
        const url = chrome.runtime.getURL("src/ui/settings.html");
        chrome.tabs.create({ url });
    } catch (_) { }
});

// Empty-state buttons reuse the toolbar scan / paste entrypoints
document.getElementById("ev-scan-primary")?.addEventListener("click", () => scanBtn?.click());
document.getElementById("ev-paste-link")?.addEventListener("click", () => customContextBtn?.click());

document.getElementById("quotaSettingsBtn")?.addEventListener("click", () => {
    try {
        const url = chrome.runtime.getURL("src/ui/settings.html") + "?section=api";
        chrome.tabs.create({ url });
    } catch (_) { }
});

window.addEventListener("unload", () => {
    scanPoller.clearAll();
    if (stateCleanupTimeout) {
        clearTimeout(stateCleanupTimeout);
        stateCleanupTimeout = null;
    }
});

// ===========================================
// Scan
// ===========================================
async function handleScan() {
    try {
        const tab = await getActiveTab();
        const blockReason = await refreshScanAvailability(tab);
        if (blockReason) return;

        setState(UI_STATE.SCANNING);
        const { html, text, title, lang, url } = await captureActiveTabHtml(tab);
        scanPoller.clearForUrl(url);

        DEBUG && debug("[Eventy][Popup] Scan started", { url });

        const { modelHtml, csvSnippets } = preprocessForPopup(text || "", html || "");

        const response = await chrome.runtime.sendMessage({
            action: "scanPage",
            modelInput: modelHtml,
            csvSnippets,
            html,
            text,
            title,
            lang,
            url,
            imageUrls: [],
        });

        if (!response?.success) {
            const errorMsg = response?.error || "Unknown error";
            error("Scan failed:", errorMsg);

            if (response?.errorType === "RATE_LIMIT" ||
                errorMsg.toLowerCase().includes("rate limit") ||
                errorMsg.toLowerCase().includes("quota") ||
                errorMsg.toLowerCase().includes("daily limit")) {
                setState(UI_STATE.QUOTA_EXCEEDED);
                return;
            }

            setState(UI_STATE.IDLE);
            if (scanBtn) scanBtn.disabled = true;
            return;
        }

        const events = response.events || [];
        if (!events.length) {
            error("No events found on this page");
            setState(UI_STATE.IDLE);
            return;
        }

        transitionFromSkeletonsToResults(events);
        await saveCache(url, events, []);

        if (tab?.id && events.length > 0) {
            try {
                const settings = await ensureSettingsLoaded();
                if (settings.showPageMarkers === true) {
                    await chrome.runtime.sendMessage({
                        action: "injectEventMarkers",
                        tabId: tab.id,
                        events: events
                    });
                }
            } catch (markerErr) {
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

        if (e.name === "RateLimitError" ||
            errorStr.toLowerCase().includes("rate limit") ||
            errorStr.toLowerCase().includes("quota") ||
            errorStr.toLowerCase().includes("daily limit")) {
            setState(UI_STATE.QUOTA_EXCEEDED);
            return;
        }

        setState(UI_STATE.IDLE);
        setScanAvailabilityReason("An error occurred. Please refresh the page.");
    }
}

// ===========================================
// Render events
// ===========================================
async function renderEvents(events) {
    await ensureSettingsLoaded();
    currentEvents = events;

    const result = await renderEventLists(events, {
        upcomingEventsListEl,
        pastEventsListEl,
        isEventPast,
        createCard: (ev, idx, color, isPast) => createEventCard(ev, idx, {
            escapeHtml,
            formatTimeOnly: (timeStr) => formatTimeOnly(timeStr),
            onToggle: () => {
                updateButtonStates();
                persistSelection(currentEvents);
            },
            color,
            isPast,
        }),
        updateButtonStates,
    });

    if (result) {
        updateToggleLabels(result.upcomingCount, result.pastCount);
        updateWeekStrip(events);
    }
}

function transitionFromSkeletonsToResults(events) {
    if (!upcomingEventsListEl) return;

    const skeletons = resultsEl.querySelectorAll(".skeleton-row");
    skeletons.forEach((skeleton, i) => {
        setTimeout(() => {
            skeleton.style.transition = `opacity ${SKELETON_FADE_DURATION_MS}ms ease, transform ${SKELETON_FADE_DURATION_MS}ms ease`;
            skeleton.style.opacity = "0";
            skeleton.style.transform = "scale(0.95)";
        }, i * SKELETON_STAGGER_DELAY_MS);
    });

    setTimeout(async () => {
        try {
            upcomingEventsListEl.innerHTML = "";
            if (pastEventsListEl) pastEventsListEl.innerHTML = "";
            await renderEvents(events);

            // Switch to upcoming tab
            switchTab("upcoming");

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

function restoreSelection(selectedIdxs) {
    const firstSelected = restoreEventSelection(selectedIdxs, {
        resultsEl,
        updateButtonStates,
    });

    if (firstSelected) scrollToCard(firstSelected);
}

scanBtn?.addEventListener("click", handleScan);
refreshScanAvailability();

// ===========================================
// Custom context (paste / image)
// ===========================================
async function saveCustomState() {
    try {
        const isCustomOpen = !customContextSection?.classList.contains("hidden");
        const text = customInput?.value || "";
        await chrome.storage.local.set({
            [KEY_CUSTOM_VIEW_ACTIVE]: isCustomOpen,
            [KEY_CUSTOM_TEXT]: text
        });
    } catch (_) { }
}

async function saveCustomFiles() {
    try {
        const serializedFiles = await Promise.all(currentImageFiles.map(async (file) => {
            if (file.data) return file;
            const base64 = await fileToBase64(file);
            return { data: base64, type: file.type, name: file.name };
        }));
        await chrome.storage.local.set({ [KEY_CUSTOM_FILES]: serializedFiles });
    } catch (e) {
        console.error("Error saving files", e);
    }
}

customContextBtn?.addEventListener("click", () => {
    const isHidden = customContextSection?.classList.contains("hidden");
    if (isHidden) {
        customContextSection.classList.remove("hidden");
        resultsEl?.classList.remove("open", "has-results");
        customInput?.focus();
    } else {
        customContextSection.classList.add("hidden");
        refreshScanAvailability();
    }
    saveCustomState();
});

const mediaInput = document.getElementById("mediaInput");
const imagePreviewContainer = document.getElementById("imagePreviewContainer");
let currentImageFiles = [];

function updateImageUI() {
    if (imagePreviewContainer) {
        imagePreviewContainer.innerHTML = "";
        currentImageFiles.forEach((file, index) => {
            const item = document.createElement("div");
            item.className = "image-preview-item";

            const img = document.createElement("img");
            img.className = "image-preview-img";

            if (file.data) {
                img.src = file.data;
            } else {
                img.src = URL.createObjectURL(file);
                img.onload = () => URL.revokeObjectURL(img.src);
            }

            const removeBtn = document.createElement("button");
            removeBtn.className = "image-remove-btn";
            removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                currentImageFiles.splice(index, 1);
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
        currentImageFiles = Array.from(mediaInput.files);
        updateImageUI();
        await saveCustomFiles();
        saveCustomState();
    }
});

customInput?.addEventListener("input", saveCustomState);
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

        const imageUrls = [];
        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                try {
                    const file = files[i];
                    if (file.data) {
                        imageUrls.push(file.data);
                    } else {
                        const base64 = await fileToBase64(file);
                        imageUrls.push(base64);
                    }
                } catch (err) {
                    error("Failed to process image:", err);
                }
            }
        }

        const tab = await getActiveTab();
        const url = tab?.url || "custom-context-scan";
        const modelInput = buildModelInput(text, null);

        const response = await chrome.runtime.sendMessage({
            action: "scanPage",
            html: "",
            modelInput,
            text: text,
            title: "Custom Context",
            lang: "en",
            url: url,
            imageUrls: imageUrls,
            cacheResults: false,
        });

        if (!response?.success) {
            const errorMsg = response?.error || "Unknown error";
            error("Scan failed:", errorMsg);

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
            return;
        }

        transitionFromSkeletonsToResults(events);
    } catch (e) {
        error(e);
        const errorStr = e.message || String(e);

        if (e.name === "RateLimitError" ||
            errorStr.toLowerCase().includes("rate limit") ||
            errorStr.toLowerCase().includes("quota") ||
            errorStr.toLowerCase().includes("daily limit")) {
            setState(UI_STATE.QUOTA_EXCEEDED);
            return;
        }

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

// ===========================================
// Calendar & ICS actions
// ===========================================
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

// ===========================================
// In-progress scan detection
// ===========================================
async function checkForInProgressScan() {
    try {
        const tab = await getActiveTab();
        const url = tab?.url || "";

        const result = await chrome.storage.local.get(`eventy-scanning:${url}`);
        const isScanning = result[`eventy-scanning:${url}`];

        if (!isScanning) return false;

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

async function ensureDeferredScanningAnimation() {
    if (currentState !== UI_STATE.SCANNING) {
        setState(UI_STATE.SCANNING);
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
}

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
        if (!stored) return false;

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

function selectAndScrollToEvent(eventIndex) {
    const card = resultsEl?.querySelector(`.event-card[data-idx="${eventIndex}"]`);
    if (!card) return;

    const allCards = resultsEl?.querySelectorAll(".event-card");
    allCards?.forEach(c => {
        c.classList.remove("selected");
        c.setAttribute("aria-pressed", "false");
    });

    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");

    scrollToCard(card);
    updateButtonStates();
    persistSelection(currentEvents);
}

async function checkPendingEventSelection() {
    try {
        const result = await chrome.storage.local.get("eventy-pending-selection");
        const pending = result["eventy-pending-selection"];

        if (!pending) return null;

        await chrome.storage.local.remove("eventy-pending-selection");

        if (Date.now() - pending.ts > 5000) return null;

        const tab = await getActiveTab();
        if (pending.tabUrl && tab?.url !== pending.tabUrl) return null;

        return pending.eventIndex;
    } catch (e) {
        error("Error checking pending selection:", e);
        return null;
    }
}

// ===========================================
// Cache restore on popup open
// ===========================================
(async function restoreFromCache() {
    try {
        const pendingEventIndex = await checkPendingEventSelection();

        if (await tryLoadDeferredResults(HIGHLIGHT_RESULTS_KEY)) return;
        if (await tryLoadDeferredResults(IMAGE_RESULTS_KEY)) return;

        const tab = await getActiveTab();
        const url = tab?.url || "";

        const hasInProgressScan = await checkForInProgressScan();
        if (hasInProgressScan) return;

        const cached = await loadCache(url);
        if (!cached || !cached.events || !cached.events.length) {
            setState(UI_STATE.IDLE);
            return;
        }

        resultsEl?.classList.add("open");

        await renderEvents(cached.events);

        requestAnimationFrame(() => {
            setState(UI_STATE.RESULTS_LOADED);

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
