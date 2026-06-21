import { PROXY_URL } from "../../../config.js";
import { error } from "../../utils/logger.js";
import { getInstallationId } from "../../utils/storage.js";

export async function postProxyJson(path, body) {
    const response = await fetch(`${PROXY_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = payload?.error?.message || payload?.error || `Request failed: ${response.status}`;
        throw new Error(message);
    }

    return payload;
}

export async function fetchAvailableModels() {
    try {
        const data = await postProxyJson("/models");
        if (!data.data || !Array.isArray(data.data)) {
            return null;
        }

        const structuredModels = data.data.filter(model =>
            model.supported_parameters &&
            model.supported_parameters.includes("structured_outputs")
        );

        structuredModels.sort((a, b) => a.name.localeCompare(b.name));

        return structuredModels;
    } catch (err) {
        error("Error fetching models:", err);
        return null;
    }
}

export function formatProviderName(provider) {
    const names = {
        "anthropic": "Anthropic",
        "openai": "OpenAI",
        "google": "Google",
        "meta-llama": "Meta Llama",
        "mistralai": "Mistral AI",
        "deepseek": "DeepSeek",
        "cohere": "Cohere",
        "microsoft": "Microsoft",
        "amazon": "Amazon",
        "qwen": "Qwen",
    };
    return names[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

function parseNumber(value) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export function getApiKeyBalanceStatus(data) {
    const limit = parseNumber(data?.limit);
    const usage = parseNumber(data?.usage) ?? 0;
    const limitRemaining = parseNumber(data?.limit_remaining);

    if (limitRemaining !== null) {
        return { hasBalance: limitRemaining > 0, limit, usage, remaining: limitRemaining };
    }

    if (limit !== null) {
        const remaining = limit - usage;
        return { hasBalance: remaining > 0, limit, usage, remaining };
    }

    return { hasBalance: true, limit, usage, remaining: null };
}

export async function validateApiKey(apiKey) {
    try {
        const payload = await postProxyJson("/validate-key", { apiKey });
        const data = payload?.data;
        if (!data) {
            return { valid: false, error: "Invalid API key" };
        }

        const balance = getApiKeyBalanceStatus(data);
        if (!balance.hasBalance) {
            return { valid: false, error: "No balance remaining on this key" };
        }

        return { valid: true, data };
    } catch (err) {
        if (err.name === "TypeError" && err.message.includes("fetch")) {
            return { valid: false, error: "Network error - check proxy connectivity" };
        }
        return { valid: false, error: err.message || "Failed to validate key" };
    }
}

export async function fetchUsageStats(chromeApi = globalThis.chrome) {
    try {
        const installationId = await getInstallationId();
        if (!installationId) {
            return null;
        }

        const localData = await chromeApi.storage.local.get("apiKey");
        const syncData = await chromeApi.storage.sync.get("settings");
        const isByok = syncData.settings?.apiKeyMode === "byok" && localData.apiKey;

        const headers = {};
        if (isByok) {
            headers["X-User-Api-Key"] = localData.apiKey;
        }

        const usageUrl = `${PROXY_URL}/usage?id=${encodeURIComponent(installationId)}`;
        const response = await fetch(usageUrl, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (err) {
        error("Error fetching usage stats:", err);
        return null;
    }
}
