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
                    expectedTitle: { type: "string" },
                    extractedTitle: { type: ["string", "null"] },
                    reason: { type: "string" },
                },
                required: ["expectedTitle", "extractedTitle", "reason"],
                additionalProperties: false,
            },
        },
        misses: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    expectedTitle: { type: "string" },
                    reason: { type: "string" },
                },
                required: ["expectedTitle", "reason"],
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
                    "You judge whether extracted calendar events match source-visible ground truth. Be strict about missing event titles, dates, times, and locations, but allow equivalent date formatting.",
            },
            {
                role: "user",
                content: JSON.stringify(
                    {
                        pageName: fixture.name,
                        pageUrl: fixture.finalUrl || fixture.url,
                        expectedEvents: fixture.expectedEvents || [],
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

export function summarizeJudgeVerdict(verdict) {
    return {
        passed: Boolean(verdict?.passed),
        matches: Array.isArray(verdict?.matches) ? verdict.matches.length : 0,
        misses: Array.isArray(verdict?.misses) ? verdict.misses.length : 0,
        hallucinations: Array.isArray(verdict?.hallucinations)
            ? verdict.hallucinations.length
            : 0,
    };
}

function parseArgs(argv) {
    const args = { names: [] };
    for (const arg of argv) {
        if (arg.startsWith("--model=")) {
            args.model = arg.slice("--model=".length);
        } else if (arg.startsWith("--judge-model=")) {
            args.judgeModel = arg.slice("--judge-model=".length);
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

async function callOpenRouter({ apiKey, body, timeoutMs = 60000 }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/ariobarin/Eventy",
                "X-Title": "Eventy real-page eval",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `OpenRouter eval request failed: ${response.status} ${text.slice(
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
    model,
    judgeModel = model,
    names = [],
    reportPath = path.join(REAL_PAGE_FIXTURE_DIR, "llm-report.json"),
} = {}) {
    if (!apiKey) {
        throw new Error(
            "Set EVENTY_EVAL_OPENROUTER_API_KEY or OPENROUTER_API_KEY to run LLM eval."
        );
    }
    if (!model) {
        throw new Error("Set EVENTY_EVAL_MODEL or pass --model=<openrouter-model>.");
    }

    const fixtures = selectFixtures(await loadRealPageAuditFixtures(), names);
    if (!fixtures.length) {
        throw new Error("No event-labeled real-page fixtures were available.");
    }

    const pages = [];
    for (const fixture of fixtures) {
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
        const extractionData = await callOpenRouter({
            apiKey,
            body: extractionBody,
        });
        const extractedEvents = extractEventsFromStructuredOutput(extractionData);
        const judgeBody = buildEventJudgeRequestBody({
            model: judgeModel,
            fixture,
            extractedEvents,
        });
        const judgeData = await callOpenRouter({ apiKey, body: judgeBody });
        const judge = parseJsonResponse(judgeData);
        const summary = summarizeJudgeVerdict(judge);
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
    const apiKey =
        process.env.EVENTY_EVAL_OPENROUTER_API_KEY ||
        process.env.OPENROUTER_API_KEY;
    const model = args.model || process.env.EVENTY_EVAL_MODEL;
    const judgeModel =
        args.judgeModel || process.env.EVENTY_EVAL_JUDGE_MODEL || model;
    const report = await runRealPageLLMEval({
        apiKey,
        model,
        judgeModel,
        names: args.names,
    });

    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
