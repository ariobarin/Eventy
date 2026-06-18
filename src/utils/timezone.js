import { debug, warn } from "./logger.js";
import { DEBUG } from "../../config.js";
import { parseTime } from "./string.js";

/**
 * List of common timezone abbreviations and their IANA timezone mappings
 * This is a simplified list - a full implementation would use a library like moment-timezone
 *
 * Note: Some abbreviations are ambiguous:
 * - CST: Central Standard Time (America/Chicago) or China Standard Time (Asia/Shanghai)
 * - IST: India Standard Time (Asia/Kolkata) or Israel Standard Time (Asia/Jerusalem)
 * Current mappings assume US/common international usage.
 */
const TIMEZONE_ABBREVIATIONS = {
    // US timezones
    PST: "America/Los_Angeles",
    PDT: "America/Los_Angeles",
    MST: "America/Denver",
    MDT: "America/Denver",
    CST: "America/Chicago",
    CDT: "America/Chicago",
    EST: "America/New_York",
    EDT: "America/New_York",
    AKST: "America/Anchorage",
    AKDT: "America/Anchorage",
    HST: "Pacific/Honolulu",
    // Common international
    GMT: "Etc/GMT",
    UTC: "UTC",
    BST: "Europe/London",
    CET: "Europe/Paris",
    CEST: "Europe/Paris",
    JST: "Asia/Tokyo",
    AEST: "Australia/Sydney",
    AEDT: "Australia/Sydney",
    IST: "Asia/Kolkata",
    PKT: "Asia/Karachi",
};

/**
 * Extract timezone information from a time string
 * @param {string} timeString - Time string potentially containing timezone
 * @returns {{timezone: string | null, cleanTime: string}} Detected timezone and cleaned time
 */
export function extractTimezone(timeString) {
    if (!timeString || typeof timeString !== "string") {
        return { timezone: null, cleanTime: timeString || "" };
    }

    // Match time followed by known TZ abbreviation (e.g., "2:00 PM EST", "14:00 PST")
    const match = timeString.match(/(.+?)\s+([A-Z]{2,5})\s*$/i);
    if (!match) {
        return { timezone: null, cleanTime: timeString.trim() };
    }

    const tzAbbr = match[2].toUpperCase();
    const timezone = TIMEZONE_ABBREVIATIONS[tzAbbr];

    return timezone
        ? { timezone, cleanTime: match[1].trim() }
        : { timezone: null, cleanTime: timeString.trim() };
}

/**
 * Convert a date/time from a source timezone to the user's local timezone
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {string} timeStr - Time string (cleaned, no TZ suffix)
 * @param {string} sourceTimezone - IANA timezone identifier
 * @returns {{date: string, time: string}} Adjusted date and time in user's local timezone
 */
export function convertTimezone(dateStr, timeStr, sourceTimezone) {
    // Return original values immediately if any required data is missing
    if (!dateStr || !sourceTimezone || !timeStr) {
        return { date: dateStr, time: timeStr };
    }

    try {
        // Validate source timezone
        try {
            Intl.DateTimeFormat(undefined, { timeZone: sourceTimezone });
        } catch (e) {
            warn(`[Timezone] Invalid source timezone: ${sourceTimezone}`);
            return { date: dateStr, time: timeStr };
        }

        // Get user's timezone
        const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

        // Optimization: If source timezone matches user's timezone, return original values immediately
        if (sourceTimezone === userTimezone) {
            return { date: dateStr, time: timeStr };
        }

        if (DEBUG) {
            debug("[Timezone] Converting:", {
                dateStr,
                timeStr,
                sourceTimezone,
                userTimezone,
            });
        }

        // Parse time using shared utility
        const parsed = parseTime(timeStr);
        if (!parsed) {
            warn(`[Timezone] Failed to parse time: ${timeStr}`);
            return { date: dateStr, time: timeStr };
        }

        let { hours, minutes } = parsed;

        // Validate hours and minutes
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            warn(`[Timezone] Invalid time values: ${hours}:${minutes}`);
            return { date: dateStr, time: timeStr };
        }

        // Parse date components
        const dateParts = dateStr.split("-");
        if (dateParts.length !== 3) {
            warn(
                `[Timezone] Invalid date format: ${dateStr}. Expected YYYY-MM-DD format.`
            );
            return { date: dateStr, time: timeStr };
        }
        const [year, month, day] = dateParts.map((s) => parseInt(s, 10));

        // Validate date components (removed overly defensive year < 1970 check)
        if (
            isNaN(year) ||
            isNaN(month) ||
            isNaN(day) ||
            month < 1 ||
            month > 12 ||
            day < 1 ||
            day > 31
        ) {
            warn(
                `[Timezone] Invalid date components: year=${year}, month=${month}, day=${day}`
            );
            return { date: dateStr, time: timeStr };
        }

        // Find the UTC timestamp that corresponds to the source local time
        // Use iterative approach to handle DST transitions correctly

        // Initial guess: Treat the target local time as if it were UTC
        let currentUTC = Date.UTC(year, month - 1, day, hours, minutes, 0);

        // Create formatter once
        const sourceFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: sourceTimezone,
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        });

        // Iterate to refine the UTC timestamp (usually converges in 1-2 iterations)
        const MAX_ITERATIONS = 3;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const parts = sourceFormatter.formatToParts(new Date(currentUTC));
            const partMap = {};
            parts.forEach((p) => (partMap[p.type] = p.value));

            const obsYear = parseInt(partMap.year, 10);
            const obsMonth = parseInt(partMap.month, 10);
            const obsDay = parseInt(partMap.day, 10);
            const obsHour = parseInt(partMap.hour, 10);
            const obsMinute = parseInt(partMap.minute, 10);

            // Compare observed wall time with target wall time
            const targetTs = Date.UTC(year, month - 1, day, hours, minutes);
            const obsTs = Date.UTC(
                obsYear,
                obsMonth - 1,
                obsDay,
                obsHour,
                obsMinute
            );

            const diffMs = targetTs - obsTs;

            if (diffMs === 0) {
                break; // Exact match found
            }

            // Adjust currentUTC by the difference
            currentUTC += diffMs;
        }

        // Verify the result to detect DST edge cases (non-existent times)
        const verification = sourceFormatter.formatToParts(
            new Date(currentUTC)
        );
        const verifiedHour = parseInt(
            verification.find((p) => p.type === "hour")?.value || "0",
            10
        );
        if (Math.abs(verifiedHour - hours) > 1) {
            warn(
                `[Timezone] Time ${hours}:${minutes} may not exist in ${sourceTimezone} on ${dateStr} (DST transition)`
            );
        }

        const sourceDate = new Date(currentUTC);

        // Format this UTC time as it appears in the user's timezone
        const userFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: userTimezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });

        const userParts = userFormatter.formatToParts(sourceDate);
        const userComponents = {};
        userParts.forEach((part) => {
            if (part.type !== "literal") {
                userComponents[part.type] = part.value;
            }
        });

        const convertedDate = `${userComponents.year}-${userComponents.month}-${userComponents.day}`;
        const convertedTime = `${userComponents.hour}:${userComponents.minute}`;

        if (DEBUG) {
            debug("[Timezone] Converted:", {
                from: `${dateStr} ${timeStr} (${sourceTimezone})`,
                to: `${convertedDate} ${convertedTime} (${userTimezone})`,
            });
        }

        return {
            date: convertedDate,
            time: convertedTime,
        };
    } catch (error) {
        warn("[Timezone] Conversion error:", error);
        return { date: dateStr, time: timeStr };
    }
}

/**
 * Process events array to detect and convert timezones
 * @param {Array} events - Array of event objects with startTime/endTime potentially containing timezone info
 * @returns {Array} Processed events with times converted to user's local timezone
 */
export function processEventTimezones(events) {
    if (!Array.isArray(events)) {
        return events;
    }

    return events.map((event) => {
        try {
            const processedEvent = { ...event };

            // Process start time
            if (event.startTime) {
                try {
                    const { timezone: startTz, cleanTime: cleanStartTime } =
                        extractTimezone(event.startTime);

                    if (startTz) {
                        // Timezone detected, convert to user's timezone
                        const converted = convertTimezone(
                            event.startDate,
                            cleanStartTime,
                            startTz
                        );
                        processedEvent.startDate = converted.date;
                        processedEvent.startTime = converted.time;

                        DEBUG &&
                            debug("[Timezone] Start time converted:", {
                                original: `${event.startDate} ${event.startTime}`,
                                converted: `${converted.date} ${converted.time}`,
                                timezone: startTz,
                            });
                    } else {
                        // No timezone, use as-is but clean the time
                        processedEvent.startTime = cleanStartTime;
                    }
                } catch (error) {
                    warn(
                        "[Timezone] Error processing start time, using original:",
                        error
                    );
                    // Keep original time on error
                    processedEvent.startTime = event.startTime;
                }
            }

            // Process end time
            if (event.endTime) {
                try {
                    const { timezone: endTz, cleanTime: cleanEndTime } =
                        extractTimezone(event.endTime);

                    if (endTz) {
                        // Timezone detected, convert to user's timezone
                        // Use original event.startDate as fallback (not processedEvent.startDate) to ensure
                        // end time conversion uses the original date, not the already-converted start date
                        const converted = convertTimezone(
                            event.endDate || event.startDate,
                            cleanEndTime,
                            endTz
                        );
                        processedEvent.endDate = converted.date;
                        processedEvent.endTime = converted.time;

                        DEBUG &&
                            debug("[Timezone] End time converted:", {
                                original: `${
                                    event.endDate || event.startDate
                                } ${event.endTime}`,
                                converted: `${converted.date} ${converted.time}`,
                                timezone: endTz,
                            });
                    } else {
                        // No timezone, use as-is but clean the time
                        processedEvent.endTime = cleanEndTime;
                    }
                } catch (error) {
                    warn(
                        "[Timezone] Error processing end time, using original:",
                        error
                    );
                    // Keep original time on error
                    processedEvent.endTime = event.endTime;
                }
            }

            return processedEvent;
        } catch (error) {
            warn(
                "[Timezone] Error processing event, returning original:",
                error
            );
            // Return original event if any processing fails
            return event;
        }
    });
}
