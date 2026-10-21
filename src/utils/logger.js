import { DEBUG } from '../../config.js';

/**
 * Conditional logging utility
 * Only logs when DEBUG is enabled
 */

export function debug(...args) {
    if (DEBUG) {
        console.debug(...args);
    }
}

// Always show warnings (potential issues should be visible in production)
export function warn(...args) {
    console.warn(...args);
}

// Always allow errors to be logged
export function error(...args) {
    console.error(...args);
}
