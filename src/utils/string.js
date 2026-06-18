export function escapeHtml(str) {
    return String(str).replace(
        /[&<>"']/g,
        (s) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            }[s] || s)
    );
}

/**
 * Pad a number with leading zeros
 * @param {number|string} n - Number to pad
 * @param {number} width - Desired width (default: 2)
 * @returns {string} Padded string
 */
export function padZero(n, width = 2) {
    return String(n).padStart(width, '0');
}

/**
 * Parse a time string into hours, minutes, and seconds
 * Handles both 12-hour (AM/PM) and 24-hour formats
 * @param {string} timeStr - Time string to parse
 * @returns {{hours: number, minutes: number, seconds: number} | null} Parsed time or null on error
 */
export function parseTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    
    const str = timeStr.trim();
    
    // Check for AM/PM format
    const ampmMatch = str.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AP]M)/i);
    if (ampmMatch) {
        let hours = parseInt(ampmMatch[1], 10);
        const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
        const seconds = ampmMatch[3] ? parseInt(ampmMatch[3], 10) : 0;
        const meridiem = ampmMatch[4].toUpperCase();
        
        // Convert to 24-hour format
        if (meridiem === 'PM' && hours !== 12) {
            hours += 12;
        } else if (meridiem === 'AM' && hours === 12) {
            hours = 0;
        }
        
        return { hours, minutes, seconds };
    }
    
    // 24-hour format or simple HH:MM[:SS]
    const parts = str.split(':');
    if (parts.length >= 2) {
        const hours = parseInt(parts[0].trim(), 10);
        const minutes = parseInt(parts[1].trim(), 10);
        const seconds = parts[2] ? parseInt(parts[2].trim(), 10) : 0;
        
        if (!isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
            return { hours, minutes, seconds };
        }
    }
    
    return null;
}

/**
 * Check if value is a non-empty array
 * @param {*} arr - Value to check
 * @returns {boolean} True if arr is an array with at least one element
 */
export function hasItems(arr) {
    return Array.isArray(arr) && arr.length > 0;
}
