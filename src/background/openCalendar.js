import { buildCalendarCreateUrl } from "../lib/calendarUrl.js";
import { createICSDownloadUrl, createMergedICSDownloadUrl, generateICSFilename } from "../lib/icsGenerator.js";

// Track active downloads to revoke blob URLs
const activeDownloads = new Map();

function notifyIcsDownloadStarted(downloadedFiles, onIcsDownloadStarted) {
    if (!downloadedFiles.length || typeof onIcsDownloadStarted !== "function") return;

    onIcsDownloadStarted({
        count: downloadedFiles.length,
        filenames: downloadedFiles.map((file) => file.filename),
    });
}

// Single listener for all downloads
chrome.downloads.onChanged.addListener((delta) => {
    if (activeDownloads.has(delta.id) && delta.state?.current) {
        const state = delta.state.current;
        
        if (state === 'complete') {
            // Add small delay to ensure file is written to disk before revoking
            setTimeout(() => {
                const icsUrl = activeDownloads.get(delta.id);
                if (icsUrl) {
                    URL.revokeObjectURL(icsUrl);
                    activeDownloads.delete(delta.id);
                }
            }, 100);
        } else if (state === 'interrupted') {
            // Revoke immediately on interruption
            const icsUrl = activeDownloads.get(delta.id);
            if (icsUrl) {
                URL.revokeObjectURL(icsUrl);
                activeDownloads.delete(delta.id);
            }
        }
    }
});

export async function downloadMergedICS(events) {
    if (!events || events.length === 0) return;

    const icsUrl = createMergedICSDownloadUrl(events);
    // Use the first event's title for the filename, or a generic name
    const filename = events.length === 1 
        ? generateICSFilename(events[0]) 
        : `events_export_${new Date().toISOString().slice(0,10)}.ics`;

    try {
        const downloadId = await chrome.downloads.download({
            url: icsUrl,
            filename: filename,
            saveAs: true // Prompt for save location for merged file
        });
        
        activeDownloads.set(downloadId, icsUrl);
    } catch (e) {
        console.error("Download failed:", e);
        URL.revokeObjectURL(icsUrl);
    }
}

export async function openCalendarEventsInBackground(events, options = {}) {
    // Load user's calendar preference
    const result = await chrome.storage.sync.get("settings");
    const settings = result.settings || {};
    const calendarType = settings.defaultCalendar || "google";

    if (calendarType === "icloud") {
        const downloadedFiles = [];

        // Generate .ics files for iCloud Calendar
        for (const ev of events) {
            const icsUrl = createICSDownloadUrl(ev);
            const filename = generateICSFilename(ev);

            try {
                // Download the .ics file and track it for cleanup
                const downloadId = await chrome.downloads.download({
                    url: icsUrl,
                    filename: filename,
                    saveAs: false // Auto-download without prompt
                });
                
                // Track this download for blob URL cleanup
                activeDownloads.set(downloadId, icsUrl);
                downloadedFiles.push({ downloadId, filename });
            } catch (e) {
                console.error("Download failed:", e);
                // Clean up the blob URL immediately if download fails
                URL.revokeObjectURL(icsUrl);
            }
        }

        notifyIcsDownloadStarted(downloadedFiles, options.onIcsDownloadStarted);
    } else {
        // Default to Google Calendar (open URLs in new tabs)
        for (const ev of events) {
            const url = buildCalendarCreateUrl(ev);
            await chrome.tabs.create({ url, active: false });
        }
    }
}
