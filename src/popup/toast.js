export function showToast(message, type = "success", doc = document) {
    const toast = doc.getElementById("toast");
    if (!toast) return;

    const content = toast.querySelector(".toast-content");
    if (content) {
        content.innerHTML = "";

        const icon = doc.createElement("span");
        icon.className = "toast-icon";

        const icons = {
            error: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
            success: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
            info: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
        };

        icon.innerHTML = icons[type] || icons.success;
        content.appendChild(icon);
        content.appendChild(doc.createTextNode(message));
    }

    toast.className = "toast";
    const toastTypeClass = {
        error: "toast-error",
        success: "toast-success",
        info: "toast-info",
    };
    toast.classList.add(toastTypeClass[type] || "toast-success");

    void toast.offsetWidth;

    toast.classList.add("visible");

    if (toast.dataset.timeoutId) {
        clearTimeout(Number(toast.dataset.timeoutId));
    }
    if (toast.dataset.hideTimeoutId) {
        clearTimeout(Number(toast.dataset.hideTimeoutId));
    }

    const timeoutId = setTimeout(() => {
        toast.classList.remove("visible");
        toast.dataset.hideTimeoutId = String(setTimeout(() => {
            toast.classList.add("hidden");
            delete toast.dataset.hideTimeoutId;
        }, 250));
        delete toast.dataset.timeoutId;
    }, 3000);

    toast.dataset.timeoutId = String(timeoutId);
}

export function hideToast(doc = document) {
    const toast = doc.getElementById("toast");
    if (!toast) return;

    if (toast.dataset.timeoutId) {
        clearTimeout(Number(toast.dataset.timeoutId));
        delete toast.dataset.timeoutId;
    }
    if (toast.dataset.hideTimeoutId) {
        clearTimeout(Number(toast.dataset.hideTimeoutId));
        delete toast.dataset.hideTimeoutId;
    }

    toast.classList.remove("visible");
    toast.classList.add("hidden");
}
