export function applyTheme(theme) {
    const body = document.body;
    if (!body) {
        return;
    }

    body.classList.remove("light-mode", "dark-mode", "auto-mode");

    switch (theme) {
        case "light":
            body.classList.add("light-mode");
            break;
        case "dark":
            body.classList.add("dark-mode");
            break;
        case "auto":
        default:
            body.classList.add("auto-mode");
            break;
    }

    // Remove loading state to show the UI with smooth fade-in
    requestAnimationFrame(() => {
        body.classList.remove("theme-loading");
        requestAnimationFrame(() => {
            body.classList.add("theme-loaded");
        });
    });
}

// Self-executing function to load theme immediately
// This replaces the separate theme-loader.js file
(async () => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    
    try {
        const result = await chrome.storage.sync.get("settings");
        const settings = result.settings || {};
        const theme = settings.darkModeSettings || "auto";

        const body = document.body;
        if (body) {
            body.classList.remove("light-mode", "dark-mode", "auto-mode");
            body.classList.add(theme === "light" ? "light-mode" : theme === "dark" ? "dark-mode" : "auto-mode");
        }
    } catch (error) {
        console.error("Error loading theme:", error);
        if (document.body) {
            document.body.classList.add("auto-mode");
        }
    } finally {
        if (document.body) {
            document.body.classList.remove("theme-loading");
            requestAnimationFrame(() => {
                document.body.classList.add("theme-loaded");
            });
        }
    }
})();
