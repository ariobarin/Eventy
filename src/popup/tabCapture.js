import {
    createTabScanAccessError,
    getScriptInjectionFailureMessage,
    getRequiredTabScanBlockReason,
} from "../utils/tabAccess.js";

export async function getActiveTab(chromeApi = globalThis.chrome) {
    const [tab] = await chromeApi.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tab;
}

export async function captureActiveTabHtml(
    activeTab = null,
    {
        chromeApi = globalThis.chrome,
        getActiveTabFn = () => getActiveTab(chromeApi),
    } = {}
) {
    const tab = activeTab || await getActiveTabFn();
    if (!tab?.id) throw new Error("No active tab");

    const blockReason = getRequiredTabScanBlockReason(tab.url);
    if (blockReason) {
        throw createTabScanAccessError(blockReason);
    }

    let injection;
    try {
        [injection] = await chromeApi.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({
                html: document.documentElement.outerHTML,
                text: document.body ? document.body.innerText : "",
                title: document.title,
                lang: document.documentElement && document.documentElement.lang,
            }),
        });
    } catch (err) {
        const message = getScriptInjectionFailureMessage(tab.url, err);
        if (message) {
            throw createTabScanAccessError(message);
        }
        throw err;
    }

    const result = injection?.result;
    if (!result) throw new Error("No page content available");

    return {
        html: result.html,
        text: result.text,
        title: result.title,
        lang: result.lang,
        url: tab.url || "",
    };
}
