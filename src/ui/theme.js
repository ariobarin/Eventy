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
