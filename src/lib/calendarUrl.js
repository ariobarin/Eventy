import { padZero } from '../utils/string.js';

export function buildCalendarCreateUrl(event) {
    const params = new URLSearchParams();
    if (event.title) params.set("text", event.title);
    if (event.location) params.set("location", event.location);
    if (event.description) params.set("details", event.description);

    function toDate(dateStr, timeStr) {
        if (!dateStr) return null;
        try {
            const dt = new Date(`${dateStr} ${timeStr || "00:00"}`);
            return isNaN(dt.getTime()) ? null : dt;
        } catch (_) {
            return null;
        }
    }

    function formatGoogleDate(dt) {
        const y = dt.getFullYear();
        const m = padZero(dt.getMonth() + 1);
        const d = padZero(dt.getDate());
        const hh = padZero(dt.getHours());
        const mm = padZero(dt.getMinutes());
        const ss = padZero(dt.getSeconds());
        return `${y}${m}${d}T${hh}${mm}${ss}`;
    }

    function formatGoogleAllDayDate(dt) {
        const y = dt.getFullYear();
        const m = padZero(dt.getMonth() + 1);
        const d = padZero(dt.getDate());
        return `${y}${m}${d}`;
    }

    function addDays(dt, days) {
        return new Date(dt.getTime() + days * 24 * 60 * 60 * 1000);
    }

    function resolveEndDate(startDate) {
        const isAllDay = !event.startTime && !event.endTime;
        const explicitEnd = toDate(event.endDate || event.startDate, event.endTime);
        if (explicitEnd && explicitEnd > startDate) {
            return isAllDay ? addDays(explicitEnd, 1) : explicitEnd;
        }
        if (event.startTime && !event.endTime) {
            return new Date(startDate.getTime() + 60 * 60 * 1000);
        }
        if (isAllDay) {
            return addDays(startDate, 1);
        }
        return explicitEnd;
    }

    const startDate = toDate(event.startDate, event.startTime);
    const endDate = startDate ? resolveEndDate(startDate) : null;
    if (startDate && endDate) {
        const dates = !event.startTime && !event.endTime
            ? `${formatGoogleAllDayDate(startDate)}/${formatGoogleAllDayDate(endDate)}`
            : `${formatGoogleDate(startDate)}/${formatGoogleDate(endDate)}`;
        params.set("dates", dates);
    }

    if (event.recurrence) {
        params.set("recur", `RRULE:${event.recurrence}`);
    }

    try {
        const timeZone = getCachedTimeZone();
        if (timeZone) params.set("ctz", timeZone);
    } catch (_) { }

    return `https://calendar.google.com/calendar/u/0/r/eventedit?${params.toString()}`;
}

let cachedTimeZone = null;
function getCachedTimeZone() {
    if (cachedTimeZone) return cachedTimeZone;
    try {
        cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return cachedTimeZone;
    } catch (_) {
        return null;
    }
}
