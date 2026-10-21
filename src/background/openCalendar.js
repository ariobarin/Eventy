import { buildCalendarCreateUrl } from "../lib/calendarUrl.js";
import { createICSDownloadUrl, generateICSFilename } from "../lib/icsGenerator.js";

// Track active downloads to revoke blob URLs
const activeDownloads = new Map();

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

export async function openCalendarEventsInBackground(events) {
    // Load user's calendar preference
    const result = await chrome.storage.sync.get("settings");
    const settings = result.settings || {};
    const calendarType = settings.defaultCalendar || "google";

    if (calendarType === "icloud") {
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
            } catch (e) {
                console.error("Download failed:", e);
                // Clean up the blob URL immediately if download fails
                URL.revokeObjectURL(icsUrl);
            }
        }
    } else {
        // Default to Google Calendar (open URLs in new tabs)
        for (const ev of events) {
            const url = buildCalendarCreateUrl(ev);
            await chrome.tabs.create({ url, active: false });
        }
    }
}
