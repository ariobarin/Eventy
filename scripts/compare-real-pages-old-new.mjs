import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
    buildEventExtractionMessages,
    buildOpenRouterRequestBody,
    extractEventsFromStructuredOutput,
} from "../src/llm/client.js";
import { preprocessForPopup } from "../src/utils/scan.js";
import {
    buildEvalTransportRequest,
    buildEventJudgeRequestBody,
    callLLMWithTelemetry,
    resolveEvalTransport,
    summarizeJudgeVerdict,
} from "./eval-real-pages-with-llm.mjs";
import { preprocessLegacyForPopup } from "./legacy-preprocess.mjs";
import {
    auditExpectedEventLabels,
    installNodeDomParser,
    loadRealPageAuditFixtures,
    REAL_PAGE_FIXTURE_DIR,
} from "./real-page-fixtures.mjs";
import { summarizeLLMBenchmarkTelemetry } from "./benchmark-telemetry.mjs";
import {
    normalizeConcurrency,
    runWithConcurrency,
} from "./benchmark-concurrency.mjs";

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
        } else if (arg.startsWith("--concurrency=")) {
            args.concurrency = arg.slice("--concurrency=".length);
        } else if (arg === "--static") {
            args.static = true;
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            args.names.push(arg);
        }
    }
    return args;
}

function csvChars(csvSnippets) {
    return csvSnippets.reduce((sum, csv) => sum + csv.length, 0);
}

function contextSeparatorChars(csvSnippets) {
    return csvSnippets.length;
}

export function contextStats(preprocessed) {
    const csvSnippets = preprocessed.csvSnippets || [];
    const csvLength = csvChars(csvSnippets);
    const separatorLength = contextSeparatorChars(csvSnippets);
    return {
        modelInputChars: preprocessed.modelHtml.length,
        csvSnippetCount: csvSnippets.length,
        csvChars: csvLength,
        separatorChars: separatorLength,
        contextChars: preprocessed.modelHtml.length + csvLength + separatorLength,
    };
}

function combinedContextForPreprocessed(preprocessed) {
    return [
        preprocessed?.modelHtml || "",
        ...(preprocessed?.csvSnippets || []),
    ].join("\n");
}

export function buildStaticVariantResult({ fixture, preprocessed }) {
    const expectedEvents = Array.isArray(fixture?.expectedEvents)
        ? fixture.expectedEvents
        : [];
    const combinedContext = combinedContextForPreprocessed(preprocessed);
    const eventLabelResults = expectedEvents.map((event, index) =>
        auditExpectedEventLabels(event, index, combinedContext, combinedContext)
    );
    const missingEventLabels = eventLabelResults.flatMap((event) =>
        event.missingLabels.map(
            (missing) => `${event.title}: ${missing.field}=${missing.label}`
        )
    );
    const misses = eventLabelResults.filter((event) => !event.passed).length;

    return {
        ...contextStats(preprocessed),
        passed: missingEventLabels.length === 0,
        matches: expectedEvents.length - misses,
        misses,
        hallucinations: 0,
        eventLabelResults,
        missingEventLabels,
    };
}

export function buildStaticComparisonPage({
    fixture,
    oldPreprocessed,
    currentPreprocessed,
}) {
    const oldResult = buildStaticVariantResult({
        fixture,
        preprocessed: oldPreprocessed,
    });
    const currentResult = buildStaticVariantResult({
        fixture,
        preprocessed: currentPreprocessed,
    });

    return {
        name: fixture.name,
        url: fixture.finalUrl || fixture.url,
        expectedEventCount: Array.isArray(fixture.expectedEvents)
            ? fixture.expectedEvents.length
            : 0,
        old: oldResult,
        current: currentResult,
        savedContextChars: oldResult.contextChars - currentResult.contextChars,
        currentVsOldContextRatio: oldResult.contextChars
            ? Number((currentResult.contextChars / oldResult.contextChars).toFixed(4))
            : null,
    };
}

function parseJsonResponse(data) {
    const content = data?.choices?.[0]?.message?.content || "";
    if (!content) return null;
    return JSON.parse(content);
}

async function callAndRecordLLM(options, requests) {
    try {
        const { data, telemetry } = await callLLMWithTelemetry(options);
        requests.push(telemetry);
        return data;
    } catch (error) {
        if (error.telemetry) {
            requests.push(error.telemetry);
        }
        throw error;
    }
}

function buildExtractionBody({ fixture, preprocessed, model }) {
    const messages = buildEventExtractionMessages({
        modelInput: preprocessed.modelHtml,
        url: fixture.finalUrl || fixture.url,
        context: {
            pageTitle: fixture.title,
            pageLang: fixture.lang,
        },
        csvSnippets: preprocessed.csvSnippets,
    });

    return {
        ...buildOpenRouterRequestBody(messages),
        model,
    };
}

async function evaluateVariant({
    fixture,
    preprocessed,
    variant,
    model,
    judgeModel,
    transport,
    timeoutMs,
    attempt = 1,
    requests = [],
}) {
    const extractionData = await callAndRecordLLM(
        {
            transport,
            body: buildExtractionBody({ fixture, preprocessed, model }),
            timeoutMs,
            metadata: {
                pageName: fixture.name,
                variant,
                phase: "extract",
                attempt,
            },
        },
        requests
    );
    const extractedEvents = extractEventsFromStructuredOutput(extractionData);
    const judgeData = await callAndRecordLLM(
        {
            transport,
            body: buildEventJudgeRequestBody({
                model: judgeModel,
                fixture,
                extractedEvents,
            }),
            timeoutMs,
            metadata: {
                pageName: fixture.name,
                variant,
                phase: "judge",
                attempt,
            },
        },
        requests
    );
    const judge = parseJsonResponse(judgeData);
    const summary = summarizeJudgeVerdict(judge, {
        expectedEventCount: fixture.expectedEvents.length,
        expectedEvents: fixture.expectedEvents,
        extractedEvents,
    });

    return {
        ...contextStats(preprocessed),
        ...summary,
        extractedEventCount: extractedEvents.length,
        extractedEvents,
        judge,
        requests,
    };
}

export function isRetryableVariantError(error) {
    const message = String(error?.message || error || "");
    return /JSON|Unexpected end|aborted|timed out|fetch failed|network/i.test(
        message
    );
}

async function evaluateVariantWithRetry(options, maxAttempts = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await evaluateVariant({ ...options, attempt });
        } catch (error) {
            lastError = error;
            if (attempt >= maxAttempts || !isRetryableVariantError(error)) {
                throw error;
            }
            console.warn(
                `retry ${options.fixture.name} ${attempt + 1}/${maxAttempts}: ${error.message}`
            );
        }
    }
    throw lastError;
}

export function buildErroredVariantResult({
    stats,
    expectedEventCount,
    requests = [],
    error,
}) {
    return {
        ...stats,
        passed: false,
        matches: 0,
        misses: expectedEventCount,
        hallucinations: 0,
        requests,
        error: error?.message || String(error || "Unknown error"),
    };
}

export function summarizeComparisonPages(pages, benchmarkRun = {}) {
    const totalOldContextChars = pages.reduce(
        (sum, page) => sum + page.old.contextChars,
        0
    );
    const totalNewContextChars = pages.reduce(
        (sum, page) => sum + page.current.contextChars,
        0
    );
    const comparablePages = pages.filter(
        (page) => !page.old.error && !page.current.error
    );
    const regressions = comparablePages.filter(
        (page) =>
            page.current.misses > page.old.misses ||
            (page.old.passed && !page.current.passed)
    );
    const improvements = comparablePages.filter(
        (page) =>
            page.current.misses < page.old.misses ||
            (!page.old.passed && page.current.passed)
    );
    const oldErrors = pages.filter((page) => page.old.error);
    const currentErrors = pages.filter((page) => page.current.error);
    const requestTelemetry = pages.flatMap((page) => [
        ...(page.old.requests || []),
        ...(page.current.requests || []),
    ]);

    return {
        pageCount: pages.length,
        oldPasses: pages.filter((page) => page.old.passed).length,
        currentPasses: pages.filter((page) => page.current.passed).length,
        regressions: regressions.map((page) => page.name),
        improvements: improvements.map((page) => page.name),
        oldErrors: oldErrors.map((page) => page.name),
        currentErrors: currentErrors.map((page) => page.name),
        totalOldContextChars,
        totalNewContextChars,
        savedContextChars: totalOldContextChars - totalNewContextChars,
        currentVsOldContextRatio: totalOldContextChars
            ? Number((totalNewContextChars / totalOldContextChars).toFixed(4))
            : null,
        savingsRatio: totalOldContextChars
            ? Number(
                  (
                      (totalOldContextChars - totalNewContextChars) /
                      totalOldContextChars
                  ).toFixed(4)
              )
            : null,
        benchmarkTelemetry: summarizeLLMBenchmarkTelemetry(
            requestTelemetry,
            benchmarkRun
        ),
        passed:
            pages.length > 0 &&
            currentErrors.length === 0 &&
            regressions.length === 0 &&
            pages.every((page) => page.current.passed),
    };
}

function selectFixtures(fixtures, names) {
    const withLabels = fixtures.filter((fixture) => fixture.expectedEvents?.length);
    if (!names.length) return withLabels;

    const wanted = new Set(names);
    const selected = withLabels.filter((fixture) => wanted.has(fixture.name));
    if (selected.length !== wanted.size) {
        const found = new Set(selected.map((fixture) => fixture.name));
        const missing = [...wanted].filter((name) => !found.has(name));
        throw new Error(
            `No event-labeled real-page fixtures matched ${missing.join(", ")}.`
        );
    }
    return selected;
}

export async function runOldNewComparison({
    transport,
    proxyUrl,
    model,
    judgeModel = model,
    names = [],
    timeoutMs = 60000,
    concurrency = 1,
    reportPath = path.join(REAL_PAGE_FIXTURE_DIR, "old-new-llm-report.json"),
} = {}) {
    const benchmarkStartedAt = new Date().toISOString();
    const benchmarkStartedAtMs = performance.now();
    const evalTransport =
        transport || resolveEvalTransport({ args: { proxyUrl } });
    if (evalTransport.mode === "missing") {
        buildEvalTransportRequest({ transport: evalTransport, body: {} });
    }
    if (!model) {
        throw new Error("Set EVENTY_EVAL_MODEL or pass --model=<openrouter-model>.");
    }

    const cleanupDomParser = await installNodeDomParser();
    const pages = [];
    try {
        const fixtures = selectFixtures(
            await loadRealPageAuditFixtures(undefined, undefined, { names }),
            names
        );
        if (!fixtures.length) {
            throw new Error("No event-labeled real-page fixtures were available.");
        }

        const comparedPages = await runWithConcurrency(
            fixtures,
            concurrency,
            async (fixture) => {
                const oldPreprocessed = preprocessLegacyForPopup(
                    fixture.text || "",
                    fixture.html || ""
                );
                const currentPreprocessed = preprocessForPopup(
                    fixture.text || "",
                    fixture.html || ""
                );
                const oldStats = contextStats(oldPreprocessed);
                const currentStats = contextStats(currentPreprocessed);
                const oldRequests = [];
                const currentRequests = [];

                const oldResult = await evaluateVariantWithRetry({
                    fixture,
                    preprocessed: oldPreprocessed,
                    variant: "old",
                    model,
                    judgeModel,
                    transport: evalTransport,
                    timeoutMs,
                    requests: oldRequests,
                }).catch((error) =>
                    buildErroredVariantResult({
                        stats: oldStats,
                        expectedEventCount: fixture.expectedEvents.length,
                        requests: oldRequests,
                        error,
                    })
                );
                const currentResult = await evaluateVariantWithRetry({
                    fixture,
                    preprocessed: currentPreprocessed,
                    variant: "current",
                    model,
                    judgeModel,
                    transport: evalTransport,
                    timeoutMs,
                    requests: currentRequests,
                }).catch((error) =>
                    buildErroredVariantResult({
                        stats: currentStats,
                        expectedEventCount: fixture.expectedEvents.length,
                        requests: currentRequests,
                        error,
                    })
                );

                const page = {
                    name: fixture.name,
                    url: fixture.finalUrl || fixture.url,
                    expectedEventCount: fixture.expectedEvents.length,
                    old: oldResult,
                    current: currentResult,
                    savedContextChars:
                        oldResult.contextChars - currentResult.contextChars,
                    currentVsOldContextRatio: oldResult.contextChars
                        ? Number(
                              (
                                  currentResult.contextChars /
                                  oldResult.contextChars
                              ).toFixed(4)
                          )
                        : null,
                };
                console.log(formatComparisonLine(page));
                return page;
            }
        );
        pages.push(...comparedPages);
    } finally {
        cleanupDomParser();
    }

    const benchmarkEndedAt = new Date().toISOString();
    const benchmarkEndedAtMs = performance.now();
    const totals = summarizeComparisonPages(pages, {
        startedAt: benchmarkStartedAt,
        endedAt: benchmarkEndedAt,
        startedAtMs: benchmarkStartedAtMs,
        endedAtMs: benchmarkEndedAtMs,
    });
    const report = {
        generatedAt: new Date().toISOString(),
        model,
        judgeModel,
        concurrency: normalizeConcurrency(concurrency),
        ...totals,
        pages,
    };

    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`report=${path.relative(process.cwd(), reportPath)}`);
    console.log(
        `summary pages=${report.pageCount} oldPasses=${report.oldPasses} currentPasses=${report.currentPasses} oldErrors=${report.oldErrors.length} currentErrors=${report.currentErrors.length} savingsRatio=${report.savingsRatio}`
    );

    return report;
}

export async function runOldNewStaticComparison({
    names = [],
    reportPath = path.join(
        REAL_PAGE_FIXTURE_DIR,
        "reports",
        "old-new-static-report.json"
    ),
} = {}) {
    const benchmarkStartedAt = new Date().toISOString();
    const benchmarkStartedAtMs = performance.now();
    const cleanupDomParser = await installNodeDomParser();
    const pages = [];
    try {
        const fixtures = selectFixtures(
            await loadRealPageAuditFixtures(undefined, undefined, { names }),
            names
        );
        if (!fixtures.length) {
            throw new Error("No event-labeled real-page fixtures were available.");
        }

        for (const fixture of fixtures) {
            const oldPreprocessed = preprocessLegacyForPopup(
                fixture.text || "",
                fixture.html || ""
            );
            const currentPreprocessed = preprocessForPopup(
                fixture.text || "",
                fixture.html || ""
            );
            const page = buildStaticComparisonPage({
                fixture,
                oldPreprocessed,
                currentPreprocessed,
            });
            pages.push(page);
            console.log(formatComparisonLine(page));
        }
    } finally {
        cleanupDomParser();
    }

    const benchmarkEndedAt = new Date().toISOString();
    const benchmarkEndedAtMs = performance.now();
    const totals = summarizeComparisonPages(pages, {
        startedAt: benchmarkStartedAt,
        endedAt: benchmarkEndedAt,
        startedAtMs: benchmarkStartedAtMs,
        endedAtMs: benchmarkEndedAtMs,
    });
    const report = {
        generatedAt: new Date().toISOString(),
        mode: "static-retention",
        ...totals,
        pages,
    };

    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`report=${path.relative(process.cwd(), reportPath)}`);
    console.log(
        `summary pages=${report.pageCount} oldPasses=${report.oldPasses} currentPasses=${report.currentPasses} oldErrors=${report.oldErrors.length} currentErrors=${report.currentErrors.length} savingsRatio=${report.savingsRatio}`
    );

    return report;
}

export function formatComparisonLine(page) {
    let status = "FAIL";
    if (page.current.error) {
        status = "ERROR";
    } else if (page.old.error && page.current.passed) {
        status = "WARN";
    } else if (
        page.current.passed &&
        (page.current.misses <= page.old.misses || !page.old.passed)
    ) {
        status = "PASS";
    }
    const oldError = page.old.error ? ` oldError=${page.old.error}` : "";
    const currentError = page.current.error
        ? ` currentError=${page.current.error}`
        : "";
    return `${status} ${page.name} old=${page.old.passed ? "pass" : "fail"} current=${page.current.passed ? "pass" : "fail"} oldMisses=${page.old.misses} currentMisses=${page.current.misses} oldContext=${page.old.contextChars} currentContext=${page.current.contextChars} saved=${page.savedContextChars}${oldError}${currentError}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.static) {
        const report = await runOldNewStaticComparison({ names: args.names });
        if (!report.passed) process.exitCode = 1;
        return;
    }

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
    const concurrency = normalizeConcurrency(
        args.concurrency || process.env.EVENTY_EVAL_CONCURRENCY
    );
    const report = await runOldNewComparison({
        transport,
        model,
        judgeModel,
        names: args.names,
        timeoutMs,
        concurrency,
    });

    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
