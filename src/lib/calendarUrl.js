import { padZero } from '../utils/string.js';

export function buildCalendarCreateUrl(event) {
    const params = new URLSearchParams();
    if (event.title) params.set("text", event.title);
    if (event.location) params.set("location", event.location);
    if (event.description) params.set("details", event.description);

    function toGoogleDate(dateStr, timeStr) {
        if (!dateStr) return null;
        try {
            const dt = new Date(`${dateStr} ${timeStr || "00:00"}`);
            if (isNaN(dt.getTime())) return null;

            const y = dt.getFullYear();
            const m = padZero(dt.getMonth() + 1);
            const d = padZero(dt.getDate());
            const hh = padZero(dt.getHours());
            const mm = padZero(dt.getMinutes());
            const ss = padZero(dt.getSeconds());
            return `${y}${m}${d}T${hh}${mm}${ss}`;
        } catch (_) {
            return null;
        }
    }

    const start = toGoogleDate(event.startDate, event.startTime);
    const end = toGoogleDate(event.endDate || event.startDate, event.endTime);
    if (start && end) params.set("dates", `${start}/${end}`);

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
