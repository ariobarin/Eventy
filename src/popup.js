import { openCalendarEventsInBackground } from "./background/openCalendar.js";
import { DEBUG } from "../config.js";
import { escapeHtml } from "./utils/string.js";
import { isFreshScanResult } from "./utils/cache.js";
import { applyTheme } from "./ui/theme.js";
import { debug, warn, error } from "./utils/logger.js";
import { htmlToMarkdown, tablesToCsvSnippets, buildModelInput } from "./llm/preprocess.js";

// ============================================================================
// ANIMATION TIMING CONSTANTS - Centralized animation parameters
// ============================================================================

// Card fade-out animation (when transitioning to scan)
const CARD_FADE_DURATION_MS = 150;
const CARD_STAGGER_DELAY_MS = 20;

// Skeleton fade-out animation (when displaying results)
const SKELETON_FADE_DURATION_MS = 200;
const SKELETON_STAGGER_DELAY_MS = 30;

// Skeleton appearance animation stagger
const SKELETON_APPEARANCE_STAGGER_MS = 80;

// Other transition timings
const RESULTS_BUTTON_APPEAR_DELAY_MS = 50;
const IDLE_STATE_CLEANUP_DELAY_MS = 400;

const HIGHLIGHT_RESULTS_KEY = "eventy-highlight-results";
const IMAGE_RESULTS_KEY = "eventy-image-results";

// Polling configuration with exponential backoff
const SCAN_POLL_INITIAL_INTERVAL_MS = 200;
const SCAN_POLL_MAX_INTERVAL_MS = 1000;
const SCAN_POLL_BACKOFF_MULTIPLIER = 1.5;
const SCAN_POLL_MAX_ATTEMPTS = 150; // Max 150 attempts (~30 seconds with backoff)
const SCAN_POLL_TIMEOUT_MS = 30000; // 30 second absolute timeout

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

const DEFAULT_POPUP_SETTINGS = Object.freeze({
    timeFormat: "12",
    darkModeSettings: "auto",
});

let cachedSettings = { ...DEFAULT_POPUP_SETTINGS };
let settingsReadyPromise = null;

function ensureSettingsLoaded() {
    if (!settingsReadyPromise) {
        settingsReadyPromise = loadSettingsFromStorage();
    }
    return settingsReadyPromise;
}

async function loadSettingsFromStorage() {
    try {
        const result = await chrome.storage.sync.get("settings");
        cachedSettings = {
            ...DEFAULT_POPUP_SETTINGS,
            ...(result.settings || {}),
        };
        return cachedSettings;
    } catch (err) {
        error("Error loading settings:", err);
        cachedSettings = { ...DEFAULT_POPUP_SETTINGS };
        return cachedSettings;
    }
}

function getTimeFormatPreference() {
    return cachedSettings.timeFormat === "24" ? "24" : "12";
}

// Kick off settings load early to minimize race conditions for UI rendering
// Kick off settings load early to minimize race conditions for UI rendering
ensureSettingsLoaded();

// Persistence Keys
const KEY_CUSTOM_VIEW_ACTIVE = "eventy-custom-view-active";
const KEY_CUSTOM_TEXT = "eventy-custom-text";
const KEY_CUSTOM_FILES = "eventy-custom-files";

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

// UI STATE MANAGEMENT - Centralized state machine for all UI transitions
// ============================================================================

const UI_STATE = {
    IDLE: "idle",
    SCANNING: "scanning",
    RESULTS_LOADED: "results_loaded",
    QUOTA_EXCEEDED: "quota_exceeded",
};

let currentState = UI_STATE.IDLE;
let stateCleanupTimeout = null; // Track cleanup timeout to prevent race conditions

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
            scanBtn.disabled = false;

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
            scanBtn.disabled = false;

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
            scanBtn.disabled = false;

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

// Check if an event has ended (is in the past)
function isEventPast(event) {
    const now = new Date();

    // Parse end date and time
    let endDate = event.endDate || event.startDate;
    let endTime = event.endTime || event.startTime || "";

    if (!endDate) return false; // If no date info, consider it upcoming

    try {
        // Parse the date string - handle various formats
        let eventEndDateTime;

        // Try to parse as ISO date first
        if (endDate.includes('T') || endDate.includes('Z')) {
            eventEndDateTime = new Date(endDate);
        } else {
            // Parse as YYYY-MM-DD or similar format
            eventEndDateTime = new Date(endDate + 'T00:00:00');
        }

        // Check if date is valid
        if (isNaN(eventEndDateTime.getTime())) {
            warn('Invalid event date:', endDate);
            return false;
        }

        // If there's an end time, parse and apply it
        if (endTime) {
            const timeParts = endTime.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
            if (timeParts) {
                let hours = parseInt(timeParts[1]);
                const minutes = parseInt(timeParts[2]);
                const seconds = timeParts[3] ? parseInt(timeParts[3]) : 0;
                const ampm = timeParts[4];

                // Convert to 24-hour format if needed
                if (ampm) {
                    const meridiem = ampm.toUpperCase();
                    if (meridiem === 'PM' && hours !== 12) {
                        hours += 12;
                    } else if (meridiem === 'AM' && hours === 12) {
                        hours = 0;
                    }
                }

                // Set the time on the event date (preserving the date)
                eventEndDateTime.setHours(hours, minutes, seconds, 0);
            } else {
                // If time format is unrecognized but time exists, try parsing as time string
                const timeStr = endTime.trim();
                const timeParts = timeStr.split(':');
                let h = NaN, m = NaN;
                if (timeParts.length === 1) {
                    h = parseInt(timeParts[0]);
                    m = 0;
                } else if (timeParts.length >= 2) {
                    h = parseInt(timeParts[0]);
                    m = parseInt(timeParts[1]);
                }
                if (!isNaN(h) && !isNaN(m)) {
                    eventEndDateTime.setHours(h, m, 0, 0);
                } else {
                    // Can't parse time, set to end of day to be safe
                    eventEndDateTime.setHours(23, 59, 59, 999);
                }
            }
        } else {
            // If no end time specified, set to end of day
            eventEndDateTime.setHours(23, 59, 59, 999);
        }

        // Compare with current time
        return eventEndDateTime < now;
    } catch (err) {
        error('Error parsing event date:', err, event);
        return false; // On error, consider it upcoming
    }
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

const CACHE_TTL_MS = 15 * 60 * 1000;


function makeCacheKey(url) {
    return `eventy-scan:${url || ""}`;
}

// Load cached results from chrome.storage.local
async function loadCache(url) {
    try {
        const key = makeCacheKey(url);
        const result = await chrome.storage.local.get(key);
        const cached = result[key];
        if (!cached || !Array.isArray(cached.events)) return null;
        if (
            typeof cached.ts !== "number" ||
            Date.now() - cached.ts > CACHE_TTL_MS
        )
            return null;
        return cached;
    } catch (_) {
        return null;
    }
}

// Save cached results to chrome.storage.local
async function saveCache(url, events, selectedIdxs) {
    try {
        const key = makeCacheKey(url);
        const payload = { events, selected: selectedIdxs, ts: Date.now() };
        await chrome.storage.local.set({ [key]: payload });
    } catch (_) { }
}

function formatDateTime(dateStr, timeStr) {
    try {
        if (!dateStr) return "";
        const iso = `${dateStr}${timeStr ? `T${timeStr}` : ""}`;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return `${dateStr}${timeStr ? ` ${timeStr}` : ""}`;
        }
        const MONTHS = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        ];
        const month = MONTHS[d.getMonth()];
        const day = String(d.getDate()).padStart(2, "0");
        const year = d.getFullYear();
        const rawHours = d.getHours();
        const minutes = String(d.getMinutes()).padStart(2, "0");

        const timeFormat = getTimeFormatPreference();
        let timePart = "";

        if (timeStr) {
            if (timeFormat === "12") {
                const period = rawHours >= 12 ? "PM" : "AM";
                let hours12 = rawHours % 12;
                if (hours12 === 0) hours12 = 12;
                const hours12Str = String(hours12);
                timePart = `${hours12Str}:${minutes} ${period}`;
            } else {
                const hours = String(rawHours).padStart(2, "0");
                timePart = `${hours}:${minutes}`;
            }
        }
        const datePart = `${month} ${day}, ${year}`;
        return timeStr ? `${datePart} ${timePart}` : datePart;
    } catch (_) {
        return `${dateStr}${timeStr ? ` ${timeStr}` : ""}`;
    }
}

// Ensure Settings button works immediately on popup load
settingsBtn?.addEventListener(
    "click",
    () => {
        try {
            const url = chrome.runtime.getURL("src/ui/settings.html");
            chrome.tabs.create({ url });
        } catch (_) { }
    },
    { once: true }
);

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
    // Clear all polling timeouts
    for (const timeout of pollTimeouts.values()) {
        if (timeout) clearTimeout(timeout);
    }
    pollTimeouts.clear();

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

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tab;
}

async function captureActiveTabHtml() {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("No active tab");
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
            html: document.documentElement.outerHTML,
            text: document.body ? document.body.innerText : "",
            title: document.title,
            lang: document.documentElement && document.documentElement.lang,
        }),
    });
    return {
        html: result.html,
        text: result.text,
        title: result.title,
        lang: result.lang,
        url: tab.url || "",
    };
}

async function handleScan() {
    try {
        setState(UI_STATE.SCANNING);
        const { html, text, title, lang, url } = await captureActiveTabHtml();
        const tab = await getActiveTab();

        // Clear any existing poll timeout for this URL before starting new scan
        const existingTimeout = pollTimeouts.get(url);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            pollTimeouts.delete(url);
        }

        DEBUG && debug("[Eventy][Popup] Scan started", { url });

        // Preprocess in popup to avoid DOMParser issues in Service Worker
        const modelInput = htmlToMarkdown(html);
        const csvSnippets = tablesToCsvSnippets(html);

        const response = await chrome.runtime.sendMessage({
            action: "scanPage",
            modelInput,
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

        // Check if this is a rate limit error
        if (e.name === "RateLimitError" ||
            errorStr.toLowerCase().includes("rate limit") ||
            errorStr.toLowerCase().includes("quota") ||
            errorStr.toLowerCase().includes("daily limit")) {
            setState(UI_STATE.QUOTA_EXCEEDED);
            return;
        }

        // Silent error handling for other errors - disable button instead of showing toast
        if (scanBtn) {
            scanBtn.title = "An error occurred. Please refresh the page.";
        }

        setState(UI_STATE.IDLE);

        // Re-disable after state transition enables it
        if (scanBtn) {
            scanBtn.disabled = true;
        }
    }
}

async function renderEvents(events) {
    await ensureSettingsLoaded();

    // Store events globally for event handlers
    currentEvents = events;

    if (!upcomingEventsListEl || !pastEventsListEl) return;

    // Clear both lists
    upcomingEventsListEl.innerHTML = "";
    pastEventsListEl.innerHTML = "";

    // Separate events into upcoming and past
    const upcomingEvents = [];
    const pastEvents = [];

    events.forEach((ev, idx) => {
        if (isEventPast(ev)) {
            pastEvents.push({ event: ev, originalIndex: idx });
        } else {
            upcomingEvents.push({ event: ev, originalIndex: idx });
        }
    });

    // Render upcoming events
    upcomingEvents.forEach(({ event: ev, originalIndex: idx }) => {
        const wrapper = createEventCard(ev, idx);
        upcomingEventsListEl.appendChild(wrapper);
    });

    // Render past events
    pastEvents.forEach(({ event: ev, originalIndex: idx }) => {
        const wrapper = createEventCard(ev, idx);
        pastEventsListEl.appendChild(wrapper);
    });

    updateButtonStates();
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
        upcomingEventsListEl.innerHTML = "";
        if (pastEventsListEl) pastEventsListEl.innerHTML = "";
        await renderEvents(events);

        // Transition to results loaded state
        // This removes 'scanning' class and adds 'has-results'
        // Button appears smoothly via CSS transitions
        setState(UI_STATE.RESULTS_LOADED);
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
// Track polling timeouts per URL to avoid race conditions with multiple popup instances
const pollTimeouts = new Map();

function createEventCard(ev, idx) {
    const wrapper = document.createElement("div");
    wrapper.className = "event-card";
    wrapper.dataset.idx = String(idx);

    const startStr = formatDateTime(ev.startDate || "", ev.startTime || "");
    const endStr = formatDateTime(
        ev.endDate || ev.startDate || "",
        ev.endTime || ""
    );
    const previewText = ev.preview || ev.title || "Untitled";
    const fullTitle = ev.title || "Untitled";
    const location = ev.location || "";
    const locationHtml = location
        ? `<div class="event-location" title="${escapeHtml(
            location
        )}">${escapeHtml(location)}</div>`
        : "";

    const recurrenceHtml = ev.recurrence
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="recurrence-icon" title="Recurring event"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`
        : "";

    wrapper.innerHTML = `
        <div class="event-row">
            <div class="event-title" title="${escapeHtml(
        fullTitle
    )}">${escapeHtml(previewText)}</div>
            <div class="event-bottom">
                <div class="event-times">
                    <div class="event-time start">
                        ${recurrenceHtml}
                        ${escapeHtml(startStr)}
                    </div>
                    ${endStr
            ? `<div class="event-time end">${escapeHtml(
                endStr
            )}</div>`
            : ""
        }
                </div>
                ${locationHtml}
            </div>
        </div>
    `;

    wrapper.addEventListener("click", () => {
        wrapper.classList.toggle("selected");
        updateButtonStates();
        persistSelection(currentEvents);
    });

    return wrapper;
}

// Helper to scroll a card into the center of the view
function scrollToCard(card) {
    const scrollContainer = card.closest(".events-list");
    if (scrollContainer) {
        requestAnimationFrame(() => {
            setTimeout(() => {
                const containerRect = scrollContainer.getBoundingClientRect();
                const cardRect = card.getBoundingClientRect();
                const currentScroll = scrollContainer.scrollTop;

                const cardCenter = cardRect.top + (cardRect.height / 2);
                const containerCenter = containerRect.top + (containerRect.height / 2);
                const diff = cardCenter - containerCenter;

                scrollContainer.scrollTo({
                    top: Math.max(0, currentScroll + diff),
                    behavior: "smooth"
                });
            }, 200);
        });
    }
}

// Helper to restore selected event indices
function restoreSelection(selectedIdxs) {
    if (!selectedIdxs?.length) return;
    const cards = resultsEl?.querySelectorAll(".event-card");
    let firstSelected = null;
    if (cards) {
        cards.forEach((el) => el.classList.remove("selected"));
        selectedIdxs.forEach((i) => {
            const el = resultsEl?.querySelector(`.event-card[data-idx="${i}"]`);
            if (el) {
                el.classList.add("selected");
                if (!firstSelected) firstSelected = el;
            }
        });
    }
    updateButtonStates();

    if (firstSelected) {
        scrollToCard(firstSelected);
    }
}

scanBtn?.addEventListener("click", handleScan);

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

function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    if (!toast) return;

    const content = toast.querySelector(".toast-content");
    if (content) {
        content.innerHTML = "";

        const icon = document.createElement("span");
        icon.className = "toast-icon";

        // Clean, minimal icons without circle borders
        const icons = {
            error: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
            success: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
            info: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
        };

        icon.innerHTML = icons[type] || icons.success;

        content.appendChild(icon);
        content.appendChild(document.createTextNode(message));
    }

    // Reset classes but keep base toast class
    toast.className = "toast";
    const toastTypeClass = {
        error: "toast-error",
        success: "toast-success",
        info: "toast-info"
    };
    toast.classList.add(toastTypeClass[type] || "toast-success");

    // Force reflow to restart transition if needed
    void toast.offsetWidth;

    toast.classList.add("visible");

    // Clear any existing timeout
    if (toast.dataset.timeoutId) {
        clearTimeout(Number(toast.dataset.timeoutId));
    }

    const timeoutId = setTimeout(() => {
        toast.classList.remove("visible");
    }, 3000);

    toast.dataset.timeoutId = String(timeoutId);
}

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



// Generic polling function
async function pollForResults(url, storageKey, onComplete, onError, options = {}) {
    let currentInterval = SCAN_POLL_INITIAL_INTERVAL_MS;
    let attempts = 0;
    const startTime = Date.now();
    const isDeferred = !url; // If no URL, we are polling a specific key (deferred)

    // Helper to cleanup
    const cleanup = () => {
        if (url) pollTimeouts.delete(url);
    };

    const poll = async () => {
        try {
            attempts++;
            const elapsedTime = Date.now() - startTime;

            // Check limits
            if (attempts >= SCAN_POLL_MAX_ATTEMPTS || elapsedTime >= SCAN_POLL_TIMEOUT_MS) {
                warn(`[Eventy] Polling timeout after ${attempts} attempts (${elapsedTime}ms)`);
                cleanup();
                if (isDeferred) {
                    await chrome.storage.local.remove(storageKey);
                }
                onError();
                return;
            }

            // Check storage
            // For URL-based scans, we check both scanning flag and result key
            // For deferred scans, we check the specific key

            let isReady = false;
            let resultData = null;

            if (isDeferred) {
                const result = await chrome.storage.local.get(storageKey);
                const stored = result[storageKey];

                if (!stored) {
                    onError(); // Disappeared
                    return;
                }

                if (stored.status === "complete") {
                    isReady = true;
                    resultData = stored;
                    await chrome.storage.local.remove(storageKey);
                } else if (stored.status === "error") {
                    await chrome.storage.local.remove(storageKey);
                    // Check if rate limit error and handle specially
                    if (stored.errorType === "RATE_LIMIT" ||
                        (stored.error && (
                            stored.error.toLowerCase().includes("rate limit") ||
                            stored.error.toLowerCase().includes("quota") ||
                            stored.error.toLowerCase().includes("daily limit")
                        ))) {
                        setState(UI_STATE.QUOTA_EXCEEDED);
                        cleanup();
                        return;
                    }
                    onError();
                    return;
                }
            } else {
                // URL based scan
                const key = `eventy-scan:${url}`;
                const scanningKey = `eventy-scanning:${url}`;
                const checkResult = await chrome.storage.local.get([key, scanningKey]);
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

            // Not ready, schedule next poll
            currentInterval = Math.min(
                currentInterval * SCAN_POLL_BACKOFF_MULTIPLIER,
                SCAN_POLL_MAX_INTERVAL_MS
            );

            const timeoutId = setTimeout(poll, currentInterval);
            if (url) pollTimeouts.set(url, timeoutId);

        } catch (e) {
            error(e);
            cleanup();
            onError();
        }
    };

    // Start polling
    const initialTimeoutId = setTimeout(poll, currentInterval);
    if (url) pollTimeouts.set(url, initialTimeoutId);
}

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
