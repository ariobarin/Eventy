export const BENCHMARK_METRIC_CATALOG = [
    {
        name: "run.durationMs",
        status: "tracked",
        reason: "Every report records wall-clock run duration.",
    },
    {
        name: "request.durationMs",
        status: "tracked",
        reason: "Every LLM request records elapsed time.",
    },
    {
        name: "request.timeToFirstResponseMs",
        status: "tracked",
        reason: "Fetch header response time is the closest non-streaming signal.",
    },
    {
        name: "tokens.inputTokens",
        status: "provider-dependent",
        reason: "Recorded when the provider returns prompt or input token usage.",
    },
    {
        name: "tokens.cachedInputTokens",
        status: "provider-dependent",
        reason: "Recorded when the provider returns cache token details.",
    },
    {
        name: "tokens.outputTokens",
        status: "provider-dependent",
        reason: "Recorded when the provider returns completion or output token usage.",
    },
    {
        name: "tokens.reasoningTokens",
        status: "provider-dependent",
        reason: "Recorded when the provider returns completion token details.",
    },
    {
        name: "cost.usd",
        status: "provider-dependent",
        reason: "Recorded when the provider returns cost information.",
    },
    {
        name: "throughput.outputTokensPerSecond",
        status: "provider-dependent",
        reason: "Derived from returned output tokens and request duration.",
    },
    {
        name: "provider.internalQueueMs",
        status: "not-observable",
        reason: "Not exposed by the chat completion response unless a provider adds it.",
    },
    {
        name: "stream.firstTokenMs",
        status: "not-applicable",
        reason: "The eval harness uses non-streaming requests.",
    },
];

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function roundNumber(value, places = 4) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function byteLength(value) {
    return Buffer.byteLength(String(value || ""), "utf8");
}

function messageContentToText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                typeof part?.text === "string" ? part.text : JSON.stringify(part)
            )
            .join("");
    }
    if (content == null) return "";
    return JSON.stringify(content);
}

function sumMessageContentChars(messages) {
    return (Array.isArray(messages) ? messages : []).reduce(
        (sum, message) => sum + messageContentToText(message?.content).length,
        0
    );
}

function firstFinite(...values) {
    for (const value of values) {
        const number = finiteNumber(value);
        if (number !== null) return number;
    }
    return null;
}

function normalizeUsage(responseData) {
    const usage = responseData?.usage || null;
    const promptDetails =
        usage?.prompt_tokens_details ||
        usage?.promptTokensDetails ||
        usage?.input_tokens_details ||
        usage?.inputTokensDetails ||
        {};
    const completionDetails =
        usage?.completion_tokens_details ||
        usage?.completionTokensDetails ||
        usage?.output_tokens_details ||
        usage?.outputTokensDetails ||
        {};

    return {
        inputTokens: firstFinite(usage?.prompt_tokens, usage?.input_tokens),
        outputTokens: firstFinite(
            usage?.completion_tokens,
            usage?.output_tokens
        ),
        totalTokens: firstFinite(usage?.total_tokens, usage?.totalTokens),
        cachedInputTokens: firstFinite(
            promptDetails?.cached_tokens,
            promptDetails?.cachedTokens,
            usage?.cached_tokens,
            usage?.cachedTokens
        ),
        cacheCreationInputTokens: firstFinite(
            promptDetails?.cache_creation_tokens,
            promptDetails?.cacheCreationTokens,
            promptDetails?.cache_creation_input_tokens,
            promptDetails?.cacheCreationInputTokens,
            usage?.cache_creation_input_tokens,
            usage?.cacheCreationInputTokens
        ),
        reasoningTokens: firstFinite(
            completionDetails?.reasoning_tokens,
            completionDetails?.reasoningTokens,
            usage?.reasoning_tokens,
            usage?.reasoningTokens
        ),
        costUsd: firstFinite(usage?.cost, usage?.cost_usd, usage?.costUsd),
        raw: usage,
    };
}

function normalizeResponse(responseData, responseStatus, responseStatusText) {
    const choice = responseData?.choices?.[0] || {};
    return {
        id: responseData?.id || null,
        model: responseData?.model || null,
        provider: responseData?.provider || null,
        object: responseData?.object || null,
        created: responseData?.created || null,
        status: responseStatus ?? null,
        statusText: responseStatusText || null,
        finishReason: choice.finish_reason || null,
        nativeFinishReason: choice.native_finish_reason || null,
    };
}

function buildThroughput(usage, durationMs) {
    const seconds = durationMs / 1000;
    return {
        outputTokensPerSecond:
            seconds > 0 && usage.outputTokens !== null
                ? roundNumber(usage.outputTokens / seconds)
                : null,
        totalTokensPerSecond:
            seconds > 0 && usage.totalTokens !== null
                ? roundNumber(usage.totalTokens / seconds)
                : null,
    };
}

export function buildLLMCallTelemetry({
    metadata = {},
    transportMode = null,
    body = {},
    responseStatus = null,
    responseStatusText = null,
    responseData = null,
    responseText = "",
    startedAt = null,
    responseStartedAt = null,
    endedAt = null,
    startedAtMs = null,
    responseStartedAtMs = null,
    endedAtMs = null,
    error = null,
} = {}) {
    const requestBodyText = JSON.stringify(body || {});
    const durationMs =
        finiteNumber(startedAtMs) !== null && finiteNumber(endedAtMs) !== null
            ? Math.max(0, endedAtMs - startedAtMs)
            : null;
    const timeToFirstResponseMs =
        finiteNumber(startedAtMs) !== null &&
        finiteNumber(responseStartedAtMs) !== null
            ? Math.max(0, responseStartedAtMs - startedAtMs)
            : null;
    const responseReadMs =
        finiteNumber(responseStartedAtMs) !== null &&
        finiteNumber(endedAtMs) !== null
            ? Math.max(0, endedAtMs - responseStartedAtMs)
            : null;
    const usage = normalizeUsage(responseData);

    return {
        pageName: metadata.pageName || null,
        variant: metadata.variant || null,
        phase: metadata.phase || null,
        attempt: metadata.attempt ?? null,
        transportMode,
        timing: {
            startedAt,
            responseStartedAt,
            endedAt,
            durationMs,
            timeToFirstResponseMs,
            responseReadMs,
        },
        request: {
            model: body?.model || null,
            messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
            promptChars: sumMessageContentChars(body?.messages),
            bodyChars: requestBodyText.length,
            bodyBytes: byteLength(requestBodyText),
            temperature: body?.temperature ?? null,
            maxTokens: body?.max_tokens ?? body?.maxTokens ?? null,
            responseFormat: body?.response_format?.type || null,
            provider: body?.provider || null,
        },
        response: {
            ...normalizeResponse(responseData, responseStatus, responseStatusText),
            bodyChars: String(responseText || "").length,
            bodyBytes: byteLength(responseText),
        },
        usage,
        throughput: buildThroughput(usage, durationMs || 0),
        error: error ? error.message || String(error) : null,
    };
}

function sumField(records, path) {
    return records.reduce((sum, record) => {
        const value = path.reduce((current, key) => current?.[key], record);
        const number = finiteNumber(value);
        return number === null ? sum : sum + number;
    }, 0);
}

function coverageFor(records, path) {
    const withValue = records.filter((record) => {
        const value = path.reduce((current, key) => current?.[key], record);
        return value !== null && value !== undefined;
    }).length;
    return {
        withValue,
        missing: records.length - withValue,
    };
}

function numericStats(records, path) {
    const values = records
        .map((record) => path.reduce((current, key) => current?.[key], record))
        .map(finiteNumber)
        .filter((value) => value !== null);
    if (!values.length) {
        return {
            withValue: 0,
            missing: records.length,
            min: null,
            max: null,
            mean: null,
            total: 0,
        };
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        withValue: values.length,
        missing: records.length - values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: roundNumber(total / values.length),
        total: roundNumber(total),
    };
}

function timingStats(records, path) {
    const stats = numericStats(records, path);
    return {
        withValue: stats.withValue,
        missing: stats.missing,
        minMs: stats.min,
        maxMs: stats.max,
        meanMs: stats.mean,
        totalMs: stats.total,
    };
}

export function summarizeLLMBenchmarkTelemetry(
    records = [],
    { startedAt = null, endedAt = null, startedAtMs = null, endedAtMs = null } = {}
) {
    const total = records.length;
    const failed = records.filter((record) => record.error).length;
    const succeeded = total - failed;
    const runDurationMs =
        finiteNumber(startedAtMs) !== null && finiteNumber(endedAtMs) !== null
            ? Math.max(0, endedAtMs - startedAtMs)
            : null;

    return {
        metricCatalog: BENCHMARK_METRIC_CATALOG,
        run: {
            startedAt,
            endedAt,
            durationMs: runDurationMs,
        },
        requests: {
            total,
            succeeded,
            failed,
            durationMs: timingStats(records, ["timing", "durationMs"]),
            timeToFirstResponseMs: timingStats(records, [
                "timing",
                "timeToFirstResponseMs",
            ]),
            responseReadMs: timingStats(records, ["timing", "responseReadMs"]),
        },
        payload: {
            promptChars: numericStats(records, ["request", "promptChars"]),
            requestBodyBytes: numericStats(records, ["request", "bodyBytes"]),
            responseBodyBytes: numericStats(records, ["response", "bodyBytes"]),
            responseBodyChars: numericStats(records, ["response", "bodyChars"]),
        },
        tokens: {
            inputTokens: sumField(records, ["usage", "inputTokens"]),
            outputTokens: sumField(records, ["usage", "outputTokens"]),
            totalTokens: sumField(records, ["usage", "totalTokens"]),
            cachedInputTokens: sumField(records, ["usage", "cachedInputTokens"]),
            cacheCreationInputTokens: sumField(records, [
                "usage",
                "cacheCreationInputTokens",
            ]),
            reasoningTokens: sumField(records, ["usage", "reasoningTokens"]),
        },
        cost: {
            usd: roundNumber(sumField(records, ["usage", "costUsd"]), 8),
        },
        throughput: {
            outputTokensPerSecond: numericStats(records, [
                "throughput",
                "outputTokensPerSecond",
            ]),
            totalTokensPerSecond: numericStats(records, [
                "throughput",
                "totalTokensPerSecond",
            ]),
        },
        coverage: {
            usage: coverageFor(records, ["usage", "raw"]),
            inputTokens: coverageFor(records, ["usage", "inputTokens"]),
            outputTokens: coverageFor(records, ["usage", "outputTokens"]),
            totalTokens: coverageFor(records, ["usage", "totalTokens"]),
            cachedInputTokens: coverageFor(records, [
                "usage",
                "cachedInputTokens",
            ]),
            cacheCreationInputTokens: coverageFor(records, [
                "usage",
                "cacheCreationInputTokens",
            ]),
            reasoningTokens: coverageFor(records, ["usage", "reasoningTokens"]),
            costUsd: coverageFor(records, ["usage", "costUsd"]),
            timeToFirstResponseMs: coverageFor(records, [
                "timing",
                "timeToFirstResponseMs",
            ]),
        },
    };
}
