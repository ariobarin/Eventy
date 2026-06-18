import { extractEventsWithOpenRouter } from "./llm/client.js";
import { openCalendarEventsInBackground } from "./background/openCalendar.js";
import { DEBUG, MOCK_MODE, MOCK_EVENTS_PATH, MOCK_DELAY_MS } from "../config.js";
import { preprocessForBackground, preprocessForPopup } from "./utils/scan.js";
import { shouldCacheScanRequest } from "./utils/scanRequest.js";
import { debug, error } from "./utils/logger.js";

const HIGHLIGHT_RESULTS_KEY = "eventy-highlight-results";
const IMAGE_RESULTS_KEY = "eventy-image-results";

// Helper to update scan status in storage
async function updateScanStatus(key, status, data = {}) {
    try {
        const payload = {
            status,
            ts: Date.now(),
            ...data
        };
        await chrome.storage.local.set({ [key]: payload });
    } catch (_) { }
}

// Helper to safely open popup
async function tryOpenPopup() {
    try {
        await chrome.action.openPopup();
    } catch (popupErr) {
        if (DEBUG) {
            try {
                debug("[Eventy][BG] Failed to open popup", popupErr);
            } catch (_) { }
        }
    }
}

async function toggleBusyCursor(tabId, busy) {
    if (!tabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (isBusy) => {
                try {
                    const STYLE_ID = "eventy-busy-cursor-style";
                    let styleEl = document.getElementById(STYLE_ID);
                    if (isBusy) {
                        if (!styleEl) {
                            styleEl = document.createElement("style");
                            styleEl.id = STYLE_ID;
                            styleEl.textContent = `html, body, * { cursor: progress !important; }`;
                            document.documentElement.appendChild(styleEl);
                        }
                    } else if (styleEl) {
                        styleEl.remove();
                    }
                } catch (_) { }
            },
            args: [busy],
        });
    } catch (_) { }
}

async function tryResolveImageToDataUrl(tabId, imageUrl) {
    try {
        if (!tabId || !imageUrl) return null;
        // If already a data URL, return as-is
        if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
            return imageUrl;
        }
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            func: async (targetUrl) => {
                try {
                    if (!targetUrl) return null;
                    if (typeof targetUrl === "string" && targetUrl.startsWith("data:")) return targetUrl;

                    const isBlob = typeof targetUrl === "string" && targetUrl.startsWith("blob:");
                    const candidates = Array.from(document.images || []);

                    // Simplified image finding logic
                    let imgEl = candidates.find(el => (el.currentSrc || el.src) === targetUrl);
                    if (!imgEl && isBlob) {
                        imgEl = candidates.find(el => el.src === targetUrl);
                    }

                    const drawToCanvas = async (el) => {
                        if (!el) return null;
                        if (!el.naturalWidth || !el.naturalHeight) {
                            await new Promise((r) => setTimeout(r, 50));
                        }
                        const w = el.naturalWidth || el.width;
                        const h = el.naturalHeight || el.height;
                        if (!w || !h) return null;
                        const canvas = document.createElement("canvas");
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext("2d");
                        ctx.drawImage(el, 0, 0, w, h);
                        try {
                            return canvas.toDataURL("image/png");
                        } catch (e) {
                            return null;
                        }
                    };

                    if (imgEl) {
                        const dataUrl = await drawToCanvas(imgEl);
                        if (dataUrl) return dataUrl;
                    }

                    // Fallback: load image with CORS anon and attempt to draw
                    // Add timeout to prevent hanging
                    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 5000));
                    const loadPromise = new Promise(async (resolve) => {
                        await new Promise((r) => setTimeout(r, 0));
                        const temp = new Image();
                        temp.crossOrigin = "anonymous";
                        temp.referrerPolicy = "no-referrer";
                        temp.onload = async () => {
                            const du = await drawToCanvas(temp);
                            resolve(du || null);
                        };
                        temp.onerror = () => resolve(null);
                        temp.src = targetUrl;
                    });

                    return await Promise.race([loadPromise, timeoutPromise]);
                } catch (_) {
                    return null;
                }
            },
            args: [imageUrl],
        });
        return injection?.result || null;
    } catch (_) {
        return null;
    }
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "eventy-scan-selection",
        title: "Scan selected text for events",
        contexts: ["selection"],
    });
    chrome.contextMenus.create({
        id: "eventy-scan-image",
        title: "Scan image for events",
        contexts: ["image"],
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "eventy-scan-selection") {
        await handleScanFromSelection(info.selectionText || "", tab);
        return;
    }
    if (info.menuItemId === "eventy-scan-image") {
        const imgUrl = info.srcUrl || "";
        await handleScanFromImage(imgUrl, tab);
        return;
    }
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "eventy-scan-selection") return;
    try {
        const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        if (!activeTab?.id) return;
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id, allFrames: false },
            func: () => window.getSelection()?.toString() || "",
        });
        const selectionText = injection?.result || "";
        await handleScanFromSelection(selectionText, activeTab);
    } catch (e) {
        error(e);
    }
});

async function handleScanFromSelection(selectionText, tab) {
    try {
        if (!selectionText.trim()) return;
        await chrome.storage.local.remove(HIGHLIGHT_RESULTS_KEY);
        const { modelHtml, csvSnippets } = preprocessForBackground(selectionText);
        const url = tab?.url || "";
        const context = { pageTitle: tab?.title, pageLang: undefined };
        const tabId = tab?.id;

        if (DEBUG) {
            try {
                debug("[Eventy][BG] Scan invoked", {
                    selectionLength: selectionText.length,
                    url,
                    pageTitle: context.pageTitle,
                });
            } catch (_) { }
        }

        const highlightMeta = {
            sourceUrl: url,
            sourceTitle: context.pageTitle || "",
            selectionPreview: selectionText?.slice(0, 500) || "",
        };

        await updateScanStatus(HIGHLIGHT_RESULTS_KEY, "scanning", highlightMeta);
        await tryOpenPopup();
        await toggleBusyCursor(tabId, true);

        try {
            const events = await extractEventsWithOpenRouter({
                modelInput: modelHtml,
                url,
                context,
                csvSnippets,
            });

            if (DEBUG) {
                try {
                    debug("[Eventy][BG] Extracted events count:", events.length);
                } catch (_) { }
            }

            await updateScanStatus(HIGHLIGHT_RESULTS_KEY, "complete", {
                ...highlightMeta,
                events,
                completedAt: Date.now(),
            });
        } finally {
            await toggleBusyCursor(tabId, false);
        }
    } catch (e) {
        await updateScanStatus(HIGHLIGHT_RESULTS_KEY, "error", {
            error: e?.message || "Highlight scan failed",
            errorType: e?.name === "RateLimitError" ? "RATE_LIMIT" : undefined
        });
        error(e);
    }
}

async function handleScanFromImage(imageUrl, tab) {
    try {
        if (!imageUrl) return;
        const url = tab?.url || "";
        const context = { pageTitle: tab?.title, pageLang: undefined };
        const tabId = tab?.id;

        if (DEBUG) {
            try {
                debug("[Eventy][BG] Image scan invoked", {
                    imageUrl,
                    url,
                    pageTitle: context.pageTitle,
                });
            } catch (_) { }
        }

        await chrome.storage.local.remove(IMAGE_RESULTS_KEY);

        const imageMeta = {
            sourceUrl: url,
            sourceTitle: context.pageTitle || "",
            originalImageUrl: imageUrl,
        };

        await updateScanStatus(IMAGE_RESULTS_KEY, "scanning", imageMeta);
        await tryOpenPopup();
        await toggleBusyCursor(tabId, true);

        try {
            // Try to convert to a base64 data URL to avoid provider-side fetch failures
            const dataUrl = await tryResolveImageToDataUrl(tabId, imageUrl);
            const imageInput = dataUrl || imageUrl;
            const events = await extractEventsWithOpenRouter({
                modelInput: "",
                url,
                context,
                csvSnippets: [],
                imageUrls: [imageInput],
            });

            if (DEBUG) {
                try {
                    debug("[Eventy][BG] Extracted events count (image):", events.length);
                } catch (_) { }
            }

            await updateScanStatus(IMAGE_RESULTS_KEY, "complete", {
                ...imageMeta,
                events,
                completedAt: Date.now(),
            });
        } finally {
            await toggleBusyCursor(tabId, false);
        }
    } catch (e) {
        await updateScanStatus(IMAGE_RESULTS_KEY, "error", {
            error: e?.message || "Image scan failed",
            errorType: e?.name === "RateLimitError" ? "RATE_LIMIT" : undefined
        });
        error(e);
    }
}

async function handleMockMode(url, shouldCache = true) {
    try {
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        await delay(Number(MOCK_DELAY_MS) || 1200);

        const mockUrl = chrome.runtime.getURL(
            (MOCK_EVENTS_PATH && String(MOCK_EVENTS_PATH)) || "src/mocks/sample-events.json"
        );
        const res = await fetch(mockUrl);
        if (!res.ok) {
            throw new Error(`Failed to load mock events (${res.status})`);
        }
        const events = await res.json();
        if (!Array.isArray(events)) {
            throw new Error("Invalid mock events JSON.");
        }

        if (shouldCache) {
            await chrome.storage.local.set({
                [`eventy-scan:${url}`]: {
                    events: events || [],
                    selected: [],
                    ts: Date.now(),
                },
            });
        }

        return { success: true, events: events || [] };
    } catch (e) {
        error("[Eventy][BG] Mock mode error:", e);
        return { success: false, error: e.message };
    }
}

// Message listener for popup-initiated scans
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "scanPage") {
        // Handle scan request asynchronously
        (async () => {
            const { html, text, title, lang, url, imageUrls } = request;
            const shouldCache = shouldCacheScanRequest(request);
            let response = { success: false, error: "Unknown error" };

            // Validate inputs early - allow empty html if text or images are present
            if ((!html && !text && (!imageUrls || !imageUrls.length)) || !url) {
                sendResponse({ success: false, error: "Missing required fields" });
                return;
            }

            try {
                if (shouldCache) {
                    await chrome.storage.local.set({
                        [`eventy-scanning:${url}`]: { startTime: Date.now() },
                    });
                }

                DEBUG && debug("[Eventy][BG] Popup scan invoked", {
                    htmlLength: html?.length || 0,
                    textLength: text?.length || 0,
                    imageCount: imageUrls?.length || 0,
                    url,
                });

                const context = {
                    pageTitle: title || "",
                    pageLang: lang || undefined,
                };

                // Handle mock mode
                if (MOCK_MODE) {
                    response = await handleMockMode(url, shouldCache);
                    return;
                }

                // Process with LLM
                // Use pre-processed markdown from popup if available (preferred for MV3/SW)
                let modelHtml = request.modelInput;
                let csvSnippets = request.csvSnippets || [];

                if (!modelHtml) {
                    // Fallback (might fail in SW if DOMParser is needed)
                    const res = preprocessForPopup(text || "", html || "");
                    modelHtml = res.modelHtml;
                    csvSnippets = res.csvSnippets;
                }

                DEBUG && debug("[Eventy][BG] Model context:", context);

                const events = await extractEventsWithOpenRouter({
                    modelInput: modelHtml, // Pass as modelInput
                    url,
                    context,
                    csvSnippets,
                    imageUrls: imageUrls || [],
                });

                if (DEBUG) {
                    try {
                        debug("[Eventy][BG] Extracted events count:", events.length);
                    } catch (_) { }
                }

                if (shouldCache) {
                    await chrome.storage.local.set({
                        [`eventy-scan:${url}`]: {
                            events: events || [],
                            selected: [],
                            ts: Date.now(),
                        },
                    });
                }

                response = { success: true, events: events || [] };
            } catch (err) {
                error("[Eventy][BG] Scan error:", err);
                response = {
                    success: false,
                    error: err.message,
                    errorType: err.name === "RateLimitError" ? "RATE_LIMIT" : undefined
                };
            } finally {
                try {
                    if (shouldCache) {
                        await chrome.storage.local.remove(`eventy-scanning:${url}`);
                    }
                } catch (_) { }

                // Send response to complete the message handler
                sendResponse(response);
            }
        })();
        // Return true to indicate we'll respond asynchronously
        return true;
    }

    // Handle request to inject event markers on the page
    if (request.action === "injectEventMarkers") {
        (async () => {
            try {
                const { tabId, events } = request;
                if (!tabId || !events) {
                    sendResponse({ success: false, error: "Missing tabId or events" });
                    return;
                }

                // Inject the content script first
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["src/content/eventMarkers.js"]
                });

                // Then send message to inject markers
                await chrome.tabs.sendMessage(tabId, {
                    action: "injectEventMarkers",
                    events: events
                });

                sendResponse({ success: true });
            } catch (err) {
                error("[Eventy][BG] Failed to inject markers:", err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // Handle request to remove event markers from the page
    if (request.action === "removeEventMarkers") {
        (async () => {
            try {
                const { tabId } = request;
                if (!tabId) {
                    sendResponse({ success: false, error: "Missing tabId" });
                    return;
                }

                await chrome.tabs.sendMessage(tabId, {
                    action: "removeEventMarkers"
                });

                sendResponse({ success: true });
            } catch (err) {
                // Silently fail - markers may not exist
                sendResponse({ success: true });
            }
        })();
        return true;
    }

    // Handle request to open popup with a specific event selected
    if (request.action === "openPopupWithEvent") {
        (async () => {
            try {
                const { eventIndex, tabUrl } = request;

                // Store the pending selection in storage for the popup to read
                await chrome.storage.local.set({
                    "eventy-pending-selection": {
                        eventIndex: eventIndex,
                        tabUrl: tabUrl,
                        ts: Date.now()
                    }
                });

                // Open the popup
                await tryOpenPopup();

                sendResponse({ success: true });
            } catch (err) {
                error("[Eventy][BG] Failed to open popup with event:", err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }
});
