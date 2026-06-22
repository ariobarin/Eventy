export const CARD_FADE_DURATION_MS = 150;
export const CARD_STAGGER_DELAY_MS = 20;
export const SKELETON_FADE_DURATION_MS = 200;
export const SKELETON_STAGGER_DELAY_MS = 30;
export const SKELETON_APPEARANCE_STAGGER_MS = 80;
export const RESULTS_BUTTON_APPEAR_DELAY_MS = 50;
export const IDLE_STATE_CLEANUP_DELAY_MS = 400;

export const HIGHLIGHT_RESULTS_KEY = "eventy-highlight-results";
export const IMAGE_RESULTS_KEY = "eventy-image-results";

export const SCAN_POLL_INITIAL_INTERVAL_MS = 200;
export const SCAN_POLL_MAX_INTERVAL_MS = 1000;
export const SCAN_POLL_BACKOFF_MULTIPLIER = 1.5;
export const SCAN_POLL_MAX_ATTEMPTS = 150;
export const SCAN_POLL_TIMEOUT_MS = 30000;

export const DEFAULT_POPUP_SETTINGS = Object.freeze({
    timeFormat: "12",
    darkModeSettings: "auto",
});

export const UI_STATE = Object.freeze({
    IDLE: "idle",
    SCANNING: "scanning",
    RESULTS_LOADED: "results_loaded",
    QUOTA_EXCEEDED: "quota_exceeded",
});

export const SCAN_AVAILABILITY_CHECKING_MESSAGE =
    "Checking page scan availability.";

export const KEY_CUSTOM_VIEW_ACTIVE = "eventy-custom-view-active";
export const KEY_CUSTOM_TEXT = "eventy-custom-text";
export const KEY_CUSTOM_FILES = "eventy-custom-files";
