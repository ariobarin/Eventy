import { PROXY_URL, PROXY_TOKEN } from "../../config.js";
import { debug } from "../utils/logger.js";
import { processEventTimezones } from "../utils/timezone.js";
import { getInstallationId } from "../utils/storage.js";

async function getApiConfig() {
    const [{ settings = {} }, { apiKey, userModel }, installationId] = await Promise.all([
        chrome.storage.sync.get("settings"),
        chrome.storage.local.get(["apiKey", "userModel"]),
        getInstallationId(),
    ]);
    const mode = settings.apiKeyMode || "shared";
    return {
        mode,
        userApiKey: mode === "byok" ? apiKey : null,
        userModel: mode === "byok" ? userModel : null,
        installationId,
    };
}

/**
 * Custom error for rate limiting.
 */
export class RateLimitError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "RateLimitError";
        this.retryAfter = details.retryAfter;
        this.limitType = details.limitType;
        this.remaining = details.remaining;
    }
}

const SYSTEM_PROMPT = `You extract calendar events from webpage HTML, text, and images (flyers, posters, schedules).
Return ONLY a JSON object with an "events" array.
Use null for any optional field when the information is not available.

Core rules:
- Preserve local dates/times exactly as written. Do NOT convert timezones.
- If a timezone/UTC offset is explicitly attached to a time or stated globally on the page (e.g., "All times ET"), include it in startTime/endTime (e.g., "2:00 PM ET", "14:00 UTC+1").
- If no timezone is specified, provide time without timezone.
- Fields allowed: title, preview (<=30 chars), startDate (YYYY-MM-DD), startTime, endDate, endTime, location, description, recurrence (RRULE fragment like FREQ=WEEKLY;BYDAY=MO).
- Extract ALL distinct events. Do not invent events.

Dates:
- If the year is missing, infer it using provided context (now/local timezone/locale). Prefer the next upcoming date unless the page clearly refers to the past.
- Date ranges like "Sep 26 - Sep 28" map to startDate/endDate.

Times:
- Time ranges like "7:00 PM - 10:00 PM" map to startTime/endTime.
- If end time is missing but a start time exists, infer a reasonable duration (1-2 hours). If no time is given, set startTime/endTime to null.

Tables/CSV:
- If CSV/markdown tables are provided, treat the first row as headers and extract one event per row when sufficient fields exist.
- Map header synonyms to canonical fields: Title, Date, Time, StartTime, EndTime, Location, Notes/Description.
- When a row has explicit date/time/location fields, use those fields for event date/time/location. Dates mentioned only inside notes or descriptions are details unless no structured date field exists.

Descriptions:
- Put remaining details (performers, fees, age limits, notes) in description.
`;

const EVENT_SCHEMA = {
    type: "object",
    properties: {
        title: { type: "string" },
        preview: {
            type: ["string", "null"],
            description:
                "Short label for picker UI (<=30 chars). Title is used if missing.",
        },
        startDate: { type: "string", description: "YYYY-MM-DD" },
        startTime: { type: ["string", "null"], description: "HH:MM or HH:MM TZ (include timezone if specified, e.g., '14:00 PST' or '2:00 PM EST' - note the space before TZ)" },
        endDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
        endTime: { type: ["string", "null"], description: "HH:MM or HH:MM TZ (include timezone if specified)" },
        location: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        recurrence: {
            type: ["string", "null"],
            description: "RRULE fragment like FREQ=WEEKLY;BYDAY=MO",
        },
    },
    required: [
        "title",
        "preview",
        "startDate",
        "startTime",
        "endDate",
        "endTime",
        "location",
        "description",
        "recurrence",
    ],
    additionalProperties: false,
};

export function buildOpenRouterRequestBody(messages) {
    return {
        messages,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "calendar_events_extraction",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        events: {
                            type: "array",
                            items: EVENT_SCHEMA,
                            description: "Array of extracted calendar events"
                        }
                    },
                    required: ["events"],
                    additionalProperties: false,
                }
            }
        },
        provider: {
            require_parameters: true,
        },
    };
}

/**
 * Extract events from structured output response.
 * With structured outputs, the response content is guaranteed to be valid JSON.
 */
export function extractEventsFromStructuredOutput(data) {
    const events = [];

    for (const choice of data.choices || []) {
        const content = choice.message?.content || "";
        if (!content) continue;

        try {
            // With structured outputs, content should be valid JSON
            const parsed = JSON.parse(content);

            if (Array.isArray(parsed?.events)) {
                events.push(...parsed.events);
            } else if (Array.isArray(parsed)) {
                // Direct array of events
                events.push(...parsed);
            } else if (parsed?.title && parsed?.startDate) {
                // Single event object
                events.push(parsed);
            }
        } catch (parseErr) {
            // Fallback: try to extract JSON from content
            debug("[Eventy][LLM] Failed to parse structured output, trying fallback:", parseErr);

            // Try to find JSON in code blocks
            const fences = [...content.matchAll(/```(?:json)?\n([\s\S]*?)```/gi)];
            const candidates = fences.length ? fences.map((m) => m[1]) : [content];

            for (const jsonText of candidates) {
                try {
                    const fallbackParsed = JSON.parse(jsonText.trim());
                    if (Array.isArray(fallbackParsed?.events)) {
                        events.push(...fallbackParsed.events);
                    } else if (Array.isArray(fallbackParsed)) {
                        events.push(...fallbackParsed);
                    }
                } catch (_) { }
            }
        }
    }

    return events;
}

function dedupeEvents(events) {
    try {
        if (!events || !events.length) return [];
        const seen = new Set();
        const out = [];
        for (const ev of events) {
            if (!ev || typeof ev !== "object") continue;
            const key = [
                (ev.title || "").trim().toLowerCase(),
                ev.startDate || "",
                ev.startTime || "",
                ev.endDate || "",
                ev.endTime || "",
                (ev.location || "").trim().toLowerCase(),
            ].join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(ev);
        }
        return out;
    } catch (_) {
        return Array.isArray(events) ? events : [];
    }
}

export function buildEventContext({ url, context = {} } = {}) {
    const now = new Date();

    return {
        nowUtc: now.toISOString(),
        nowLocal: now.toString(),
        tz: (() => {
            try {
                return Intl.DateTimeFormat().resolvedOptions().timeZone;
            } catch {
                return undefined;
            }
        })(),
        locale:
            typeof navigator !== "undefined" && navigator.language
                ? navigator.language
                : "en-US",
        pageUrl: url,
        pageTitle: context.pageTitle,
        pageLang: context.pageLang,
        ...context,
    };
}

export function buildEventExtractionMessages({
    modelInput,
    url,
    context = {},
    csvSnippets = [],
    imageUrls = [],
} = {}) {
    const ctx = buildEventContext({ url, context });
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user",
            content: `Current page URL: ${url}\nContext JSON (use for resolving relative dates like 'tomorrow', 'next Friday', etc.):\n${JSON.stringify(ctx)}\nExtract ALL distinct events from the provided inputs (Markdown/Text content and/or images). Return a valid JSON object with an "events" array.`
        },
        ...(csvSnippets.length
            ? [
                {
                    role: "user",
                    content:
                        "Preprocessed tables as CSV (use to ensure table rows are not missed):",
                },
                ...csvSnippets.map((csv) => ({
                    role: "user",
                    content: "```csv\n" + csv + "\n```",
                })),
            ]
            : []),
        { role: "user", content: "Page Content (Markdown/Text):" },
        { role: "user", content: modelInput || "" },
    ];

    if (Array.isArray(imageUrls) && imageUrls.length) {
        const content = [
            { type: "text", text: "Images to scan for events:" },
            ...imageUrls.map((u) => ({
                type: "image_url",
                image_url: { url: String(u) },
            })),
        ];
        messages.push({ role: "user", content });
    }

    return messages;
}

export async function extractEventsWithOpenRouter({
    modelInput,
    url,
    context = {},
    csvSnippets = [],
    imageUrls = [],
}) {
    if (!PROXY_URL) throw new Error("Proxy not configured.");

    const apiConfig = await getApiConfig();

    const headers = { "Content-Type": "application/json" };
    if (PROXY_TOKEN) headers["X-Eventy-Token"] = PROXY_TOKEN;
    if (apiConfig.installationId) {
        headers["X-Installation-Id"] = apiConfig.installationId;
    }
    if (apiConfig.mode === "byok" && apiConfig.userApiKey) {
        headers["X-User-Api-Key"] = apiConfig.userApiKey;
        if (apiConfig.userModel) {
            headers["X-User-Model"] = apiConfig.userModel;
        }
    }

    const messages = buildEventExtractionMessages({
        modelInput: modelInput || "",
        url,
        context,
        csvSnippets,
        imageUrls,
    });
    debug("[Eventy][LLM] Request:", {
        headers: Object.keys(headers),
        inputLength: (modelInput || "").length,
        csvSnippetCount: csvSnippets.length,
        imageCount: imageUrls.length,
        pageUrl: url,
    });

    let response;
    try {
        response = await fetch(PROXY_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(buildOpenRouterRequestBody(messages)),
            signal: AbortSignal.timeout(60000),
        });
    } catch (err) {
        if (err.name === "TimeoutError") {
            throw new Error("Request timed out after 60 seconds");
        }
        throw err;
    }

    if (!response.ok) {
        const text = await response.text();
        const truncatedText = text.slice(0, 1000) + (text.length > 1000 ? "..." : "");
        debug("[Eventy][LLM] Error response text:", truncatedText);

        if (response.status === 429) {
            let errorData = {};
            try {
                errorData = JSON.parse(text);
            } catch (_) { }
            throw new RateLimitError(
                errorData.message || "Rate limit exceeded. Please try again later.",
                {
                    retryAfter: errorData.retryAfter,
                    limitType: errorData.limitType,
                    remaining: errorData.remaining,
                }
            );
        }

        throw new Error(`OpenRouter error: ${response.status} ${truncatedText}`);
    }

    const data = await response.json();
    const events = dedupeEvents(extractEventsFromStructuredOutput(data));
    debug("[Eventy][LLM] Extracted events:", events.length);

    try {
        return processEventTimezones(events);
    } catch (error) {
        debug("[Eventy][LLM] Timezone processing failed, returning original events:", error);
        return events;
    }
}
