
import { padZero } from '../utils/string.js';

// iCalendar format requires CRLF line endings
const CRLF = '\r\n';

function toDate(dateStr, timeStr) {
    if (!dateStr) return null;

    try {
        const dt = new Date(`${dateStr} ${timeStr || '00:00'}`);
        return isNaN(dt.getTime()) ? null : dt;
    } catch (e) {
        return null;
    }
}

function addDays(dt, days) {
    return new Date(dt.getTime() + days * 24 * 60 * 60 * 1000);
}

function addHours(dt, hours) {
    return new Date(dt.getTime() + hours * 60 * 60 * 1000);
}

function formatICSAllDayDate(dt) {
    const y = dt.getFullYear();
    const m = padZero(dt.getMonth() + 1);
    const d = padZero(dt.getDate());
    return `${y}${m}${d}`;
}

// Helper to format dates as iCalendar format in floating time (YYYYMMDDTHHMMSS)
// Using floating time (no 'Z' suffix) to avoid timezone shifts
function formatICSDateTime(dt) {
    if (!dt) return null;

    const y = dt.getFullYear();
    const m = padZero(dt.getMonth() + 1);
    const d = padZero(dt.getDate());
    const hh = padZero(dt.getHours());
    const mm = padZero(dt.getMinutes());
    const ss = padZero(dt.getSeconds());
    return `${y}${m}${d}T${hh}${mm}${ss}`;
}

// Helper to escape text for iCalendar format
function escapeICS(text) {
    if (!text) return '';
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');
}

// Helper to fold lines longer than 75 octets (per RFC 5545)
function foldLine(line) {
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

    if (!encoder || encoder.encode(line).length <= 75) return line;

    const folded = [];
    let remaining = line;

    while (remaining.length > 0) {
        const maxChars = folded.length === 0 ? 75 : 74;
        let cutPoint = remaining.length;

        for (let i = Math.min(cutPoint, maxChars); i > 0; i--) {
            const chunk = remaining.substring(0, i);
            if (encoder.encode(chunk).length <= maxChars) {
                cutPoint = i;
                break;
            }
        }

        if (cutPoint === 0) cutPoint = 1;

        folded.push(remaining.substring(0, cutPoint));
        remaining = remaining.substring(cutPoint);
        if (remaining.length > 0) {
            remaining = ' ' + remaining;
        }
    }

    return folded.join(CRLF);
}

function generateVEVENT(event) {
    const lines = [];

    // Generate unique ID for event
    let uid;
    try {
        uid = `${crypto.randomUUID()}@eventy`;
    } catch (_) {
        uid = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}@eventy`;
    }

    // Get current timestamp for DTSTAMP (must be UTC)
    const now = new Date();
    const dtstamp = `${now.getUTCFullYear()}${padZero(now.getUTCMonth() + 1)}${padZero(now.getUTCDate())}T${padZero(now.getUTCHours())}${padZero(now.getUTCMinutes())}${padZero(now.getUTCSeconds())}Z`;

    // Event start
    lines.push('BEGIN:VEVENT');

    // Required fields
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);

    // Event summary (title)
    if (event.title) {
        lines.push(foldLine(`SUMMARY:${escapeICS(event.title)}`));
    }

    const startDate = toDate(event.startDate, event.startTime);
    if (!startDate) {
        // Skip invalid events instead of throwing error for merged ICS
        console.warn('DTSTART is required for VEVENT', event);
        return [];
    }

    const isAllDay = !event.startTime && !event.endTime;
    if (isAllDay) {
        const explicitEndDate = toDate(event.endDate, null);
        const endDate = explicitEndDate && explicitEndDate > startDate
            ? addDays(explicitEndDate, 1)
            : addDays(startDate, 1);
        lines.push(`DTSTART;VALUE=DATE:${formatICSAllDayDate(startDate)}`);
        lines.push(`DTEND;VALUE=DATE:${formatICSAllDayDate(endDate)}`);
    } else {
        const parsedEnd = event.endTime
            ? toDate(event.endDate || event.startDate, event.endTime)
            : null;
        const endDate = parsedEnd || addHours(startDate, 1);
        lines.push(`DTSTART:${formatICSDateTime(startDate)}`);
        lines.push(`DTEND:${formatICSDateTime(endDate)}`);
    }

    // Location
    if (event.location) {
        lines.push(foldLine(`LOCATION:${escapeICS(event.location)}`));
    }

    // Description
    if (event.description) {
        lines.push(foldLine(`DESCRIPTION:${escapeICS(event.description)}`));
    }

    // Recurrence rule
    if (event.recurrence) {
        let rrule = event.recurrence;
        if (!rrule.toUpperCase().startsWith('FREQ=')) {
            console.warn('[Eventy] Suspicious RRULE format:', event.recurrence);
        }
        lines.push(foldLine(`RRULE:${rrule}`));
    }

    // Event end
    lines.push('END:VEVENT');

    return lines;
}

function generateVCALENDAR(vevents) {
    const lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//Eventy//Event Extractor//EN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    
    lines.push(...vevents);

    lines.push('END:VCALENDAR');
    return lines.join(CRLF);
}

/**
 * Generate an iCalendar (.ics) file content from an event object
 * Compatible with iCloud Calendar, Apple Calendar, Google Calendar, Outlook, etc.
 */
export function generateICS(event) {
    const vevent = generateVEVENT(event);
    if (vevent.length === 0) throw new Error('Invalid event data');
    return generateVCALENDAR(vevent);
}

/**
 * Generate an iCalendar (.ics) file content from multiple event objects
 */
export function generateMergedICS(events) {
    const vevents = [];
    for (const event of events) {
        vevents.push(...generateVEVENT(event));
    }
    return generateVCALENDAR(vevents);
}

/**
 * Create a downloadable .ics file from event data
 * Returns a blob URL that can be used to download the file
 */
export function createICSDownloadUrl(event) {
    const icsContent = generateICS(event);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    return URL.createObjectURL(blob);
}

/**
 * Create a downloadable .ics file from multiple events
 */
export function createMergedICSDownloadUrl(events) {
    const icsContent = generateMergedICS(events);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    return URL.createObjectURL(blob);
}

/**
 * Generate a safe filename for the .ics file
 */
export function generateICSFilename(event) {
    const title = event.title || 'event';
    const safeTitle = title
        .replace(/[^a-zA-Z0-9\s_-]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 50);

    const date = event.startDate ? event.startDate.replace(/-/g, '') : '';

    return `${safeTitle}_${date}.ics`;
}
