import { PROXY_URL, PROXY_TOKEN, DEBUG } from "../../config.js";
import { debug } from "../utils/logger.js";
import { processEventTimezones } from "../utils/timezone.js";
import { getInstallationId } from "../utils/storage.js";

// getInstallationId imported from utils/storage.js

/**
 * Get API configuration (BYOK mode and keys).
 */
async function getApiConfig() {
    try {
        const [syncResult, localResult] = await Promise.all([
            chrome.storage.sync.get("settings"),
            chrome.storage.local.get(["apiKey", "userModel", "installationId"])
        ]);

        let installationId = localResult.installationId;
        if (!installationId) {
            installationId = crypto.randomUUID();
            await chrome.storage.local.set({ installationId });
        }

        const settings = syncResult.settings || {};
        const mode = settings.apiKeyMode || "shared";

        return {
            mode,
            userApiKey: mode === "byok" ? localResult.apiKey : null,
            userModel: mode === "byok" ? localResult.userModel : null,
            installationId
        };
    } catch (err) {
        DEBUG && debug("[Eventy][LLM] Error getting API config:", err);
        return {
            mode: "shared",
            userApiKey: null,
            userModel: null,
            installationId: await getInstallationId()
        };
    }
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
- If end time is missing but a start time exists, infer a reasonable duration (1-2 hours). If no time is given, omit startTime/endTime.

Tables/CSV:
- If CSV/markdown tables are provided, treat the first row as headers and extract one event per row when sufficient fields exist.
- Map header synonyms to canonical fields: Title, Date, Time, StartTime, EndTime, Location, Notes/Description.

Descriptions:
- Put remaining details (performers, fees, age limits, notes) in description.
`;

const EVENT_SCHEMA = {
    type: "object",
    properties: {
        title: { type: "string" },
        preview: {
            type: "string",
            description:
                "Short label for picker UI (<=30 chars). Title is used if missing.",
        },
        startDate: { type: "string", description: "YYYY-MM-DD" },
        startTime: { type: "string", description: "HH:MM or HH:MM TZ (include timezone if specified, e.g., '14:00 PST' or '2:00 PM EST' - note the space before TZ)" },
        endDate: { type: "string", description: "YYYY-MM-DD" },
        endTime: { type: "string", description: "HH:MM or HH:MM TZ (include timezone if specified)" },
        location: { type: "string" },
        description: { type: "string" },
        recurrence: {
            type: "string",
            description: "RRULE fragment like FREQ=WEEKLY;BYDAY=MO",
        },
    },
    required: ["title", "startDate"],
    additionalProperties: false,
};

/**
 * Extract events from structured output response.
 * With structured outputs, the response content is guaranteed to be valid JSON.
 */
function extractEventsFromStructuredOutput(data) {
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
            DEBUG && debug("[Eventy][LLM] Failed to parse structured output, trying fallback:", parseErr);

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

export async function extractEventsWithOpenRouter({
    modelInput, // Renamed from html, contains Markdown or Text or HTML
    html, // Backward compatibility
    url,
    context = {},
    csvSnippets = [],
    imageUrls = [],
}) {
    const contentInput = modelInput || html || ""; // Use modelInput preferred



    const now = new Date();

    const ctx = {
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

    if (!PROXY_URL) throw new Error("Proxy not configured.");

    // Get API configuration
    const apiConfig = await getApiConfig();

    const headers = { "Content-Type": "application/json" };
    if (PROXY_TOKEN) headers["X-Eventy-Token"] = PROXY_TOKEN;

    // Add installation ID for rate limiting
    if (apiConfig.installationId) {
        headers["X-Installation-Id"] = apiConfig.installationId;
    }

    // Add user API key and model if BYOK mode
    if (apiConfig.mode === "byok" && apiConfig.userApiKey) {
        headers["X-User-Api-Key"] = apiConfig.userApiKey;
        if (apiConfig.userModel) {
            headers["X-User-Model"] = apiConfig.userModel;
        }
    }

    DEBUG && debug("[Eventy][LLM] Prepared context:", ctx);
    DEBUG && debug("[Eventy][LLM] Request preview:", {
        url: PROXY_URL,
        headers: Object.keys(headers),
        messageSummary: {
            hasCsvSnippets: !!csvSnippets.length,
            csvSnippetCount: csvSnippets.length,
            inputLength: typeof contentInput === "string" ? contentInput.length : 0,
            pageUrl: url,
        },
    });

    // Build messages with optional image content (OpenAI-style multimodal format)
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
        { role: "user", content: contentInput },
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
        DEBUG && debug("[Eventy][LLM] Including image URLs:", imageUrls);
    }

    // Add timeout to prevent hanging (60 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
        response = await fetch(PROXY_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({
                messages,
                // Using structured outputs only - no function calling
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
                temperature: 0,
            }),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === "AbortError") {
            throw new Error("Request timed out after 60 seconds");
        }
        throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const text = await response.text();
        // Limit error log size to prevent overflow
        const truncatedText = text.slice(0, 1000) + (text.length > 1000 ? "..." : "");
        if (DEBUG) {
            try {
                debug("[Eventy][LLM] Error response text:", truncatedText);
            } catch (_) { }
        }

        // Handle rate limiting
        if (response.status === 429) {
            try {
                const errorData = JSON.parse(text);
                throw new RateLimitError(
                    errorData.message || "Rate limit exceeded. Please try again later.",
                    {
                        retryAfter: errorData.retryAfter,
                        limitType: errorData.limitType,
                        remaining: errorData.remaining
                    }
                );
            } catch (parseErr) {
                if (parseErr instanceof RateLimitError) throw parseErr;
                throw new RateLimitError("Rate limit exceeded. Please try again later.");
            }
        }

        throw new Error(`OpenRouter error: ${response.status} ${truncatedText}`);
    }

    const data = await response.json();
    DEBUG && debug(
        "[Eventy][LLM] Raw model response (truncated):",
        JSON.stringify(data).slice(0, 4000)
    );

    // Extract events from structured output
    const extractedEvents = extractEventsFromStructuredOutput(data);
    DEBUG && debug(
        "[Eventy][LLM] Extracted events from structured output:",
        extractedEvents.length
    );

    // Process events for timezone conversion
    const events = dedupeEvents(extractedEvents);

    // Convert timezones if detected
    try {
        const processedEvents = processEventTimezones(events);

        DEBUG && debug("[Eventy][LLM] Events after timezone processing:", processedEvents.length);

        return processedEvents;
    } catch (error) {
        // If timezone processing fails, return original events
        DEBUG && debug("[Eventy][LLM] Timezone processing failed, returning original events:", error);
        return events;
    }
}
