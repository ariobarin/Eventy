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
    buildEvalTransportRequest,
    buildEventJudgeRequestBody,
    resolveEvalTransport,
    summarizeJudgeVerdict,
} from "./eval-real-pages-with-llm.mjs";
import { preprocessLegacyForPopup } from "./legacy-preprocess.mjs";
import {
    installNodeDomParser,
    loadRealPageAuditFixtures,
    REAL_PAGE_FIXTURE_DIR,
} from "./real-page-fixtures.mjs";

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

function csvChars(csvSnippets) {
    return csvSnippets.reduce((sum, csv) => sum + csv.length, 0);
}

export function contextStats(preprocessed) {
    const csvLength = csvChars(preprocessed.csvSnippets || []);
    return {
        modelInputChars: preprocessed.modelHtml.length,
        csvSnippetCount: (preprocessed.csvSnippets || []).length,
        csvChars: csvLength,
        contextChars: preprocessed.modelHtml.length + csvLength,
    };
}

function parseJsonResponse(data) {
    const content = data?.choices?.[0]?.message?.content || "";
    if (!content) return null;
    return JSON.parse(content);
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
                `LLM comparison request failed: ${response.status} ${text.slice(
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
    model,
    judgeModel,
    transport,
    timeoutMs,
}) {
    const extractionData = await callLLM({
        transport,
        body: buildExtractionBody({ fixture, preprocessed, model }),
        timeoutMs,
    });
    const extractedEvents = extractEventsFromStructuredOutput(extractionData);
    const judgeData = await callLLM({
        transport,
        body: buildEventJudgeRequestBody({
            model: judgeModel,
            fixture,
            extractedEvents,
        }),
        timeoutMs,
    });
    const judge = parseJsonResponse(judgeData);
    const summary = summarizeJudgeVerdict(judge, {
        expectedEventCount: fixture.expectedEvents.length,
        expectedEvents: fixture.expectedEvents,
    });

    return {
        ...contextStats(preprocessed),
        ...summary,
        extractedEventCount: extractedEvents.length,
        extractedEvents,
        judge,
    };
}

export function buildErroredVariantResult({
    stats,
    expectedEventCount,
    error,
}) {
    return {
        ...stats,
        passed: false,
        matches: 0,
        misses: expectedEventCount,
        hallucinations: 0,
        error: error?.message || String(error || "Unknown error"),
    };
}

export function summarizeComparisonPages(pages) {
    const totalOldContextChars = pages.reduce(
        (sum, page) => sum + page.old.contextChars,
        0
    );
    const totalNewContextChars = pages.reduce(
        (sum, page) => sum + page.current.contextChars,
        0
    );
    const regressions = pages.filter(
        (page) =>
            page.current.misses > page.old.misses ||
            (page.old.passed && !page.current.passed)
    );
    const improvements = pages.filter(
        (page) =>
            page.current.misses < page.old.misses ||
            (!page.old.passed && page.current.passed)
    );

    return {
        pageCount: pages.length,
        oldPasses: pages.filter((page) => page.old.passed).length,
        currentPasses: pages.filter((page) => page.current.passed).length,
        regressions: regressions.map((page) => page.name),
        improvements: improvements.map((page) => page.name),
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
        passed:
            pages.length > 0 &&
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
    reportPath = path.join(REAL_PAGE_FIXTURE_DIR, "old-new-llm-report.json"),
} = {}) {
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

        for (const fixture of fixtures) {
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

            const oldResult = await evaluateVariant({
                fixture,
                preprocessed: oldPreprocessed,
                model,
                judgeModel,
                transport: evalTransport,
                timeoutMs,
            }).catch((error) =>
                buildErroredVariantResult({
                    stats: oldStats,
                    expectedEventCount: fixture.expectedEvents.length,
                    error,
                })
            );
            const currentResult = await evaluateVariant({
                fixture,
                preprocessed: currentPreprocessed,
                model,
                judgeModel,
                transport: evalTransport,
                timeoutMs,
            }).catch((error) =>
                buildErroredVariantResult({
                    stats: currentStats,
                    expectedEventCount: fixture.expectedEvents.length,
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
                              currentResult.contextChars / oldResult.contextChars
                          ).toFixed(4)
                      )
                    : null,
            };
            pages.push(page);
            console.log(formatComparisonLine(page));
        }
    } finally {
        cleanupDomParser();
    }

    const totals = summarizeComparisonPages(pages);
    const report = {
        generatedAt: new Date().toISOString(),
        model,
        judgeModel,
        ...totals,
        pages,
    };

    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`report=${path.relative(process.cwd(), reportPath)}`);
    console.log(
        `summary pages=${report.pageCount} oldPasses=${report.oldPasses} currentPasses=${report.currentPasses} savingsRatio=${report.savingsRatio}`
    );

    return report;
}

export function formatComparisonLine(page) {
    const status =
        page.current.passed &&
        (page.current.misses <= page.old.misses || !page.old.passed)
            ? "PASS"
            : "FAIL";
    const oldError = page.old.error ? ` oldError=${page.old.error}` : "";
    const currentError = page.current.error
        ? ` currentError=${page.current.error}`
        : "";
    return `${status} ${page.name} old=${page.old.passed ? "pass" : "fail"} current=${page.current.passed ? "pass" : "fail"} oldMisses=${page.old.misses} currentMisses=${page.current.misses} oldContext=${page.old.contextChars} currentContext=${page.current.contextChars} saved=${page.savedContextChars}${oldError}${currentError}`;
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
    const report = await runOldNewComparison({
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
