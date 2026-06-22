import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    buildEventExtractionMessages,
    buildOpenRouterRequestBody,
    extractEventsFromStructuredOutput,
} from "../src/llm/client.js";
import { preprocessForPopup } from "../src/utils/scan.js";
import {
    installNodeDomParser,
    loadRealPageAuditFixtures,
    REAL_PAGE_FIXTURE_DIR,
} from "./real-page-fixtures.mjs";

const OPENROUTER_CHAT_COMPLETIONS_URL =
    "https://openrouter.ai/api/v1/chat/completions";

const JUDGE_SCHEMA = {
    type: "object",
    properties: {
        passed: { type: "boolean" },
        matches: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    expectedIndex: { type: "integer" },
                    expectedTitle: { type: "string" },
                    extractedTitle: { type: ["string", "null"] },
                    reason: { type: "string" },
                },
                required: [
                    "expectedIndex",
                    "expectedTitle",
                    "extractedTitle",
                    "reason",
                ],
                additionalProperties: false,
            },
        },
        misses: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    expectedIndex: { type: "integer" },
                    expectedTitle: { type: "string" },
                    reason: { type: "string" },
                },
                required: ["expectedIndex", "expectedTitle", "reason"],
                additionalProperties: false,
            },
        },
        hallucinations: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    extractedTitle: { type: "string" },
                    reason: { type: "string" },
                },
                required: ["extractedTitle", "reason"],
                additionalProperties: false,
            },
        },
        notes: { type: ["string", "null"] },
    },
    required: ["passed", "matches", "misses", "hallucinations", "notes"],
    additionalProperties: false,
};

export function buildEventJudgeRequestBody({ model, fixture, extractedEvents }) {
    return {
        model,
        messages: [
            {
                role: "system",
                content:
                    "You judge whether extracted calendar events include source-visible expected events. The expected events are non-exhaustive must-find labels, not a complete inventory. Return exactly one outcome for each expected event: put it in matches if it is present, or misses if it is absent. A matches entry must use the expectedIndex from expectedEvents and must never describe an extra extracted event. Do not list the same expectedIndex in both matches and misses. Be strict about missing expected titles, dates, times, and locations, but allow equivalent date formatting and allow a source-visible venue suffix, category suffix, or stage suffix on extracted titles when the core expected title and other fields match. Do not mark an extracted event as a hallucination only because it is absent from the expected list.",
            },
            {
                role: "user",
                content: JSON.stringify(
                    {
                        pageName: fixture.name,
                        pageUrl: fixture.finalUrl || fixture.url,
                        expectedEventsAreExhaustive: false,
                        expectedEvents: (fixture.expectedEvents || []).map(
                            (event, expectedIndex) => ({
                                ...event,
                                expectedIndex,
                            })
                        ),
                        extractedEvents,
                    },
                    null,
                    2
                ),
            },
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "event_extraction_judge",
                strict: true,
                schema: JUDGE_SCHEMA,
            },
        },
        provider: {
            require_parameters: true,
        },
        temperature: 0,
    };
}

export function summarizeJudgeVerdict(
    verdict,
    {
        expectedEventCount = 0,
        expectedEvents = [],
        groundTruthExhaustive = false,
    } = {}
) {
    const rawMatches = Array.isArray(verdict?.matches) ? verdict.matches : [];
    const rawMisses = Array.isArray(verdict?.misses) ? verdict.misses : [];
    const hallucinations = Array.isArray(verdict?.hallucinations)
        ? verdict.hallucinations.length
        : 0;
    const expectedCount = expectedEvents.length || expectedEventCount;
    const expectedTitleKeys = new Map(
        expectedEvents
            .map((event, index) => [normalizeJudgeTitle(event?.title), index])
            .filter(([title]) => title)
    );

    const hasExpectedEvents = expectedCount > 0;
    let matches = rawMatches.length;
    let misses = rawMisses.length;

    if (expectedEvents.length) {
        const matchedKeys = new Set();
        for (const match of rawMatches) {
            if (!match?.extractedTitle) continue;
            const key = resolveJudgeExpectedKey(
                match,
                expectedCount,
                expectedTitleKeys
            );
            if (key) matchedKeys.add(key);
        }

        const missedKeys = new Set();
        for (const miss of rawMisses) {
            const key = resolveJudgeExpectedKey(
                miss,
                expectedCount,
                expectedTitleKeys
            );
            if (key && !matchedKeys.has(key)) missedKeys.add(key);
        }

        matches = matchedKeys.size;
        misses = missedKeys.size;
    }

    const hasCompleteMatchCount =
        expectedCount > 0 && matches >= expectedCount;
    return {
        passed:
            misses === 0 &&
            (!groundTruthExhaustive || hallucinations === 0) &&
            (hasExpectedEvents
                ? hasCompleteMatchCount
                : Boolean(verdict?.passed)),
        matches,
        misses,
        hallucinations,
    };
}

function normalizeJudgeTitle(title) {
    return String(title || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function resolveJudgeExpectedKey(item, expectedCount, expectedTitleKeys) {
    if (
        Number.isInteger(item?.expectedIndex) &&
        item.expectedIndex >= 0 &&
        item.expectedIndex < expectedCount
    ) {
        return `index:${item.expectedIndex}`;
    }

    const titleKey = expectedTitleKeys.get(normalizeJudgeTitle(item?.expectedTitle));
    return Number.isInteger(titleKey) ? `index:${titleKey}` : null;
}

export function buildErroredEvalPage({ fixture, model, judgeModel, error }) {
    const expectedEventCount = fixture.expectedEvents?.length || 0;
    return {
        name: fixture.name,
        url: fixture.finalUrl || fixture.url,
        model,
        judgeModel,
        expectedEventCount,
        extractedEventCount: 0,
        passed: false,
        matches: 0,
        misses: expectedEventCount,
        hallucinations: 0,
        extractedEvents: [],
        judge: null,
        error: error?.message || String(error || "Unknown LLM eval error"),
    };
}

function parseArgs(argv) {
    const args = { names: [] };
    for (const arg of argv) {
        if (arg.startsWith("--model=")) {
            args.model = arg.slice("--model=".length);
        } else if (arg.startsWith("--judge-model=")) {
            args.judgeModel = arg.slice("--judge-model=".length);
        } else if (arg.startsWith("--proxy-url=")) {
            args.proxyUrl = arg.slice("--proxy-url=".length);
        } else if (arg.startsWith("--timeout-ms=")) {
            args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            args.names.push(arg);
        }
    }
    return args;
}

function parseJsonResponse(data) {
    const content = data?.choices?.[0]?.message?.content || "";
    if (!content) return null;
    return JSON.parse(content);
}

export function resolveEvalTransport({ env = process.env, args = {} } = {}) {
    const proxyUrl = args.proxyUrl || env.EVENTY_EVAL_PROXY_URL;
    if (proxyUrl) {
        return {
            mode: "proxy",
            proxyUrl,
            proxyToken: env.EVENTY_EVAL_PROXY_TOKEN || env.EVENTY_TOKEN || "",
        };
    }

    const apiKey =
        args.apiKey ||
        env.EVENTY_EVAL_OPENROUTER_API_KEY ||
        env.OPENROUTER_API_KEY;
    if (apiKey) {
        return {
            mode: "openrouter",
            apiKey,
        };
    }

    return { mode: "missing" };
}

export function buildEvalTransportRequest({ transport, body }) {
    if (transport?.mode === "proxy") {
        const headers = {
            "Content-Type": "application/json",
        };
        if (transport.proxyToken) {
            headers["X-Eventy-Token"] = transport.proxyToken;
        }
        return {
            url: transport.proxyUrl,
            headers,
            body: JSON.stringify(body),
        };
    }

    if (transport?.mode === "openrouter") {
        return {
            url: OPENROUTER_CHAT_COMPLETIONS_URL,
            headers: {
                Authorization: `Bearer ${transport.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/ariobarin/Eventy",
                "X-Title": "Eventy real-page eval",
            },
            body: JSON.stringify(body),
        };
    }

    throw new Error(
        "Set EVENTY_EVAL_PROXY_URL or EVENTY_EVAL_OPENROUTER_API_KEY/OPENROUTER_API_KEY to run LLM eval."
    );
}

async function callLLM({ transport, body, timeoutMs = 60000 }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const request = buildEvalTransportRequest({ transport, body });
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `LLM eval request failed: ${response.status} ${text.slice(
                    0,
                    500
                )}`
            );
        }

        return response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

function selectFixtures(fixtures, names) {
    const withLabels = fixtures.filter((fixture) => fixture.expectedEvents?.length);
    if (!names.length) return withLabels;

    const wanted = new Set(names);
    const selected = withLabels.filter((fixture) => wanted.has(fixture.name));
    if (selected.length !== wanted.size) {
        const found = new Set(selected.map((fixture) => fixture.name));
        const missing = [...wanted].filter((name) => !found.has(name));
        throw new Error(`No event-labeled real-page fixtures matched ${missing.join(", ")}.`);
    }
    return selected;
}

export async function runRealPageLLMEval({
    apiKey,
    proxyUrl,
    transport,
    model,
    judgeModel = model,
    names = [],
    timeoutMs = 60000,
    reportPath = path.join(REAL_PAGE_FIXTURE_DIR, "llm-report.json"),
} = {}) {
    const evalTransport =
        transport || resolveEvalTransport({ args: { apiKey, proxyUrl } });
    if (evalTransport.mode === "missing") {
        buildEvalTransportRequest({ transport: evalTransport, body: {} });
    }
    if (!model) {
        throw new Error("Set EVENTY_EVAL_MODEL or pass --model=<openrouter-model>.");
    }

    const cleanupDomParser = await installNodeDomParser();
    let pages = [];
    try {
        const fixtures = selectFixtures(
            await loadRealPageAuditFixtures(undefined, undefined, { names }),
            names
        );
        if (!fixtures.length) {
            throw new Error("No event-labeled real-page fixtures were available.");
        }

        for (const fixture of fixtures) {
            try {
                const { modelHtml, csvSnippets } = preprocessForPopup(
                    fixture.text || "",
                    fixture.html || ""
                );
                const messages = buildEventExtractionMessages({
                    modelInput: modelHtml,
                    url: fixture.finalUrl || fixture.url,
                    context: {
                        pageTitle: fixture.title,
                        pageLang: fixture.lang,
                    },
                    csvSnippets,
                });
                const extractionBody = {
                    ...buildOpenRouterRequestBody(messages),
                    model,
                };
                const extractionData = await callLLM({
                    transport: evalTransport,
                    body: extractionBody,
                    timeoutMs,
                });
                const extractedEvents =
                    extractEventsFromStructuredOutput(extractionData);
                const judgeBody = buildEventJudgeRequestBody({
                    model: judgeModel,
                    fixture,
                    extractedEvents,
                });
                const judgeData = await callLLM({
                    transport: evalTransport,
                    body: judgeBody,
                    timeoutMs,
                });
                const judge = parseJsonResponse(judgeData);
                const summary = summarizeJudgeVerdict(judge, {
                    expectedEventCount: fixture.expectedEvents.length,
                    expectedEvents: fixture.expectedEvents,
                });
                pages.push({
                    name: fixture.name,
                    url: fixture.finalUrl || fixture.url,
                    model,
                    judgeModel,
                    expectedEventCount: fixture.expectedEvents.length,
                    extractedEventCount: extractedEvents.length,
                    ...summary,
                    extractedEvents,
                    judge,
                });
                console.log(
                    `${summary.passed ? "PASS" : "FAIL"} ${fixture.name} matches=${summary.matches} misses=${summary.misses} hallucinations=${summary.hallucinations}`
                );
            } catch (error) {
                const page = buildErroredEvalPage({
                    fixture,
                    model,
                    judgeModel,
                    error,
                });
                pages.push(page);
                console.log(`ERROR ${fixture.name} ${page.error}`);
            }
        }
    } finally {
        cleanupDomParser();
    }

    const report = {
        generatedAt: new Date().toISOString(),
        model,
        judgeModel,
        pageCount: pages.length,
        passed: pages.every((page) => page.passed),
        pages,
    };

    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`report=${path.relative(process.cwd(), reportPath)}`);

    return report;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const transport = resolveEvalTransport({
        env: process.env,
        args: {
            proxyUrl: args.proxyUrl,
        },
    });
    const model = args.model || process.env.EVENTY_EVAL_MODEL;
    const judgeModel =
        args.judgeModel || process.env.EVENTY_EVAL_JUDGE_MODEL || model;
    const timeoutMs =
        Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
            ? args.timeoutMs
            : Number(process.env.EVENTY_EVAL_TIMEOUT_MS || 60000);
    const report = await runRealPageLLMEval({
        transport,
        model,
        judgeModel,
        names: args.names,
        timeoutMs,
    });

    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
