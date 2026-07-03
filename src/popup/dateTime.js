export function isEventPast(event, { now = new Date(), warn = () => { }, error = () => { } } = {}) {
    let endDate = event.endDate || event.startDate;
    let endTime = event.endTime || event.startTime || "";

    if (!endDate) return false;

    try {
        let eventEndDateTime;

        if (endDate.includes("T") || endDate.includes("Z")) {
            eventEndDateTime = new Date(endDate);
        } else {
            eventEndDateTime = new Date(`${endDate}T00:00:00`);
        }

        if (Number.isNaN(eventEndDateTime.getTime())) {
            warn("Invalid event date:", endDate);
            return false;
        }

        if (endTime) {
            const timeParts = endTime.match(
                /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i
            );
            if (timeParts) {
                let hours = parseInt(timeParts[1]);
                const minutes = parseInt(timeParts[2]);
                const seconds = timeParts[3] ? parseInt(timeParts[3]) : 0;
                const ampm = timeParts[4];

                if (ampm) {
                    const meridiem = ampm.toUpperCase();
                    if (meridiem === "PM" && hours !== 12) {
                        hours += 12;
                    } else if (meridiem === "AM" && hours === 12) {
                        hours = 0;
                    }
                }

                eventEndDateTime.setHours(hours, minutes, seconds, 0);
            } else {
                const timeStr = endTime.trim();
                const parts = timeStr.split(":");
                let h = NaN;
                let m = NaN;
                if (parts.length === 1) {
                    h = parseInt(parts[0]);
                    m = 0;
                } else if (parts.length >= 2) {
                    h = parseInt(parts[0]);
                    m = parseInt(parts[1]);
                }
                if (!Number.isNaN(h) && !Number.isNaN(m)) {
                    eventEndDateTime.setHours(h, m, 0, 0);
                } else {
                    eventEndDateTime.setHours(23, 59, 59, 999);
                }
            }
        } else {
            eventEndDateTime.setHours(23, 59, 59, 999);
        }

        return eventEndDateTime < now;
    } catch (err) {
        error("Error parsing event date:", err, event);
        return false;
    }
}

export function formatDateHeader(dateStr) {
    if (!dateStr) return "";
    try {
        const d = new Date(`${dateStr}T00:00:00`);
        if (Number.isNaN(d.getTime())) return dateStr;

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const diffDays = Math.round((target - today) / 86400000);

        if (diffDays === 0) return "Today";
        if (diffDays === -1) return "Yesterday";
        if (diffDays === 1) return "Tomorrow";

        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
    } catch (_) {
        return dateStr;
    }
}

export function formatTimeOnly(timeStr, timeFormat = "12") {
    if (!timeStr) return "";
    const normalized = normalizeTimeStr(timeStr);
    if (!normalized) return timeStr;

    const parts = normalized.split(":");
    if (parts.length < 2) return timeStr;

    const hours = parseInt(parts[0], 10);
    const minutes = parts[1].substring(0, 2);

    if (Number.isNaN(hours)) return timeStr;

    if (timeFormat === "24") {
        return `${String(hours).padStart(2, "0")}:${minutes}`;
    }

    const period = hours >= 12 ? "PM" : "AM";
    let h12 = hours % 12;
    if (h12 === 0) h12 = 12;
    return `${h12}:${minutes} ${period}`;
}

function normalizeTimeStr(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AP]M)/i);
    if (!match) return timeStr;
    let hours = parseInt(match[1], 10);
    const minutes = match[2] ? match[2] : "00";
    const seconds = match[3] ? match[3] : "00";
    const meridiem = match[4].toUpperCase();
    if (meridiem === "PM" && hours !== 12) hours += 12;
    else if (meridiem === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${minutes}:${seconds}`;
}

export function formatDateTime(dateStr, timeStr, timeFormat = "12") {
    try {
        if (!dateStr) return "";
        const normalizedTime = normalizeTimeStr(timeStr);
        const iso = `${dateStr}${normalizedTime ? `T${normalizedTime}` : ""}`;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return `${dateStr}${timeStr ? ` ${timeStr}` : ""}`;
        }
        const months = [
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
        const month = months[d.getMonth()];
        const day = String(d.getDate()).padStart(2, "0");
        const year = d.getFullYear();
        const rawHours = d.getHours();
        const minutes = String(d.getMinutes()).padStart(2, "0");

        let timePart = "";
        if (timeStr) {
            if (timeFormat === "12") {
                const period = rawHours >= 12 ? "PM" : "AM";
                let hours12 = rawHours % 12;
                if (hours12 === 0) hours12 = 12;
                timePart = `${hours12}:${minutes} ${period}`;
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
