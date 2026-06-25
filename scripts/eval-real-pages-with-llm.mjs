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
    installNodeDomParser,
    loadRealPageAuditFixtures,
    REAL_PAGE_FIXTURE_DIR,
} from "./real-page-fixtures.mjs";
import {
    buildLLMCallTelemetry,
    summarizeLLMBenchmarkTelemetry,
} from "./benchmark-telemetry.mjs";
import {
    normalizeConcurrency,
    runWithConcurrency,
} from "./benchmark-concurrency.mjs";

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
                    "You judge whether extracted calendar events include source-visible expected events. The expected events are non-exhaustive must-find labels, not a complete inventory. Return exactly one outcome for each expected event: put it in matches if it is present, or misses if it is absent. A matches entry must use the expectedIndex from expectedEvents and must never describe an extra extracted event. Do not list the same expectedIndex in both matches and misses. Be strict about every supplied expected field, including titles, dates, times, locations, recurrence, and description details, but allow equivalent date formatting and allow a source-visible venue suffix, category suffix, or stage suffix on extracted titles when the core expected title and other supplied fields match. Do not mark an extracted event as a hallucination only because it is absent from the expected list.",
            },
            {
                role: "user",
                content: JSON.stringify(
                    {
                        pageName: fixture.name,
                        pageUrl: fixture.finalUrl || fixture.url,
                        expectedEventsAreExhaustive: false,
                        expectedEvents: (fixture.expectedEvents || []).map(
                            (event, expectedIndex) =>
                                expectedEventForJudge(event, expectedIndex)
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

function expectedEventForJudge(event, expectedIndex) {
    const { labels, ...judgeEvent } = event || {};
    return {
        ...judgeEvent,
        expectedIndex,
    };
}

export function summarizeJudgeVerdict(
    verdict,
    {
        expectedEventCount = 0,
        expectedEvents = [],
        extractedEvents = [],
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

        expectedEvents.forEach((event, index) => {
            if (matchedKeys.has(`index:${index}`)) return;
            if (extractedEvents.some((extracted) => extractedEventMatchesExpected(extracted, event))) {
                matchedKeys.add(`index:${index}`);
            }
        });

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
    if (hasExpectedEvents && matches < expectedCount) {
        misses = Math.max(misses, expectedCount - matches);
    }

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

function normalizeJudgeText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u2018\u2019\u201b]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function extractedEventMatchesExpected(extracted, expected) {
    if (
        !expected?.title ||
        normalizeJudgeTitle(extracted?.title) !== normalizeJudgeTitle(expected.title)
    ) {
        return false;
    }

    return Object.keys(expected)
        .filter((field) => !["labels", "title"].includes(field))
        .every((field) =>
            expectedFieldMatchesExtractedEvent(expected, extracted, field)
        );
}

function expectedFieldMatchesExtractedEvent(expected, extracted, field) {
    const expectedValue = String(expected?.[field] || "").trim();
    if (!expectedValue) return true;

    if (field === "date") {
        return extractedDateMatchesExpected(extracted, expectedValue);
    }

    if (field === "time") {
        return extractedTimeMatchesExpected(extracted, expectedValue);
    }

    return normalizeJudgeText(extractedEventSearchText(extracted)).includes(
        normalizeJudgeText(expectedValue)
    );
}

function extractedDateMatchesExpected(extracted, expectedDate) {
    const expectedRange = parseDateRange(expectedDate);
    if (dateLooksLikeRange(expectedDate)) {
        return (
            expectedRange &&
            extractedDateRangeMatchesExpected(extracted, expectedRange)
        );
    }

    if (!hasExplicitYear(expectedDate)) {
        const expectedMonthDay = parseMonthDayKey(expectedDate);
        if (expectedMonthDay) {
            const hasMatchingMonthDay = [extracted?.startDate, extracted?.endDate]
                .map(dateKey)
                .some(
                    (candidate) =>
                        candidate && candidate.slice(5) === expectedMonthDay
                );
            if (hasMatchingMonthDay) return true;
        }
    }

    const expectedKey = dateKey(expectedDate);
    if (!expectedKey) {
        return normalizeJudgeText(extractedEventSearchText(extracted)).includes(
            normalizeJudgeText(expectedDate)
        );
    }

    return [extracted?.startDate, extracted?.endDate]
        .map(dateKey)
        .some((candidate) => candidate === expectedKey);
}

function extractedDateRangeMatchesExpected(extracted, expectedRange) {
    return (
        extractedDatePartMatchesExpected(extracted?.startDate, expectedRange.start) &&
        extractedDatePartMatchesExpected(extracted?.endDate, expectedRange.end)
    );
}

function extractedDatePartMatchesExpected(candidateDate, expectedPart) {
    const candidateKey = dateKey(candidateDate);
    if (!candidateKey) return false;
    if (expectedPart.kind === "monthDay") {
        return candidateKey.slice(5) === expectedPart.key;
    }
    return candidateKey === expectedPart.key;
}

function extractedTimeMatchesExpected(extracted, expectedTime) {
    const expectedText = normalizeJudgeText(expectedTime);
    const startText = normalizeJudgeText(extracted?.startTime);
    const endText = normalizeJudgeText(extracted?.endTime);
    const rangeText = normalizeJudgeText(
        [extracted?.startTime, extracted?.endTime].filter(Boolean).join(" ")
    );
    const searchText = normalizeJudgeText(extractedEventSearchText(extracted));
    const expectedRange = parseTimeRange(expectedTime);
    const startValue = extracted?.startTime;
    const endValue = extracted?.endTime;
    const extractedRange =
        startValue &&
        endValue &&
        !parseTimeRange(startValue) &&
        !parseTimeRange(endValue)
            ? parseTimeRange(`${startValue} - ${endValue}`)
            : null;

    if (expectedRange) {
        return (
            extractedRange &&
            expectedRange.start === extractedRange.start &&
            expectedRange.end === extractedRange.end
        );
    }
    if (timeLooksLikeRange(expectedTime)) return false;

    return (
        (startText && expectedText.includes(startText)) ||
        (endText && expectedText.includes(endText)) ||
        (rangeText && expectedText.includes(rangeText)) ||
        searchText.includes(expectedText)
    );
}

function hasExplicitYear(value) {
    return /\b\d{4}\b/.test(String(value || ""));
}

const MONTH_INDEXES = new Map(
    [
        ["jan", 1],
        ["january", 1],
        ["feb", 2],
        ["february", 2],
        ["mar", 3],
        ["march", 3],
        ["apr", 4],
        ["april", 4],
        ["may", 5],
        ["jun", 6],
        ["june", 6],
        ["jul", 7],
        ["july", 7],
        ["aug", 8],
        ["august", 8],
        ["sep", 9],
        ["sept", 9],
        ["september", 9],
        ["oct", 10],
        ["october", 10],
        ["nov", 11],
        ["november", 11],
        ["dec", 12],
        ["december", 12],
    ].map(([name, month]) => [name, String(month).padStart(2, "0")])
);

function parseMonthDayKey(value) {
    const text = normalizeJudgeText(value);
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const monthFirst = new RegExp(`\\b${monthName}\\.?\\s+${day}\\b`, "i");
    const dayFirst = new RegExp(`\\b${day}\\s+${monthName}\\.?\\b`, "i");
    const match = text.match(monthFirst);
    if (match) return formatMonthDay(match[1], match[2]);

    const reverseMatch = text.match(dayFirst);
    if (reverseMatch) return formatMonthDay(reverseMatch[2], reverseMatch[1]);

    return "";
}

function formatMonthDay(monthName, dayValue) {
    const month = MONTH_INDEXES.get(String(monthName || "").toLowerCase());
    const day = Number(dayValue);
    if (!month || !Number.isInteger(day) || day < 1 || day > 31) return "";
    return `${month}-${String(day).padStart(2, "0")}`;
}

function dateKey(value) {
    const parsed = parseDateKey(value);
    if (parsed) return parsed;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
}

function parseDateKey(value) {
    return parseStructuredDateKey(value);
}

function parseStructuredDateKey(value) {
    const text = normalizeJudgeText(value);
    const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
        return validDateParts(isoMatch[1], isoMatch[2], isoMatch[3])
            ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
            : "";
    }

    const monthDayYear = parseNaturalMonthDayYear(text);
    if (monthDayYear) return monthDayYear;

    const numeric = parseNumericDateKey(text);
    if (numeric) return numeric;

    return "";
}

function parseDateRange(value) {
    const text = normalizeJudgeText(value);
    const compactRange =
        parseCompactSameMonthRange(text) ||
        parseCompactMonthToMonthRange(text) ||
        parseCompactDayRangeSameMonth(text);
    if (compactRange) return inferDateRangeYears(compactRange);

    const parts = text
        .split(/\s+(?:-|to|until)\s+/i)
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length < 2) return null;

    const start = parseDateRangePart(parts[0]);
    const end = parseDateRangePart(parts.slice(1).join(" "));
    if (!start || !end) return null;
    return inferDateRangeYears({ start, end });
}

function parseCompactSameMonthRange(text) {
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const match = String(text || "").match(
        new RegExp(
            `\\b${monthName}\\.?\\s+${day}\\s*-\\s*${day}(?:,?\\s+(\\d{4}))?\\b`,
            "i"
        )
    );
    if (!match) return null;

    const [, monthNameValue, startDay, endDay, year] = match;
    if (year) {
        const start = formatDateKey(year, monthNameValue, startDay);
        const end = formatDateKey(year, monthNameValue, endDay);
        return start && end
            ? {
                  start: { kind: "date", key: start },
                  end: { kind: "date", key: end },
              }
            : null;
    }

    const start = formatMonthDay(monthNameValue, startDay);
    const end = formatMonthDay(monthNameValue, endDay);
    return start && end
        ? {
              start: { kind: "monthDay", key: start },
              end: { kind: "monthDay", key: end },
          }
        : null;
}

function parseCompactMonthToMonthRange(text) {
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const match = String(text || "").match(
        new RegExp(
            `\\b${monthName}\\.?\\s+${day}\\s*-\\s*${monthName}\\.?\\s+${day}(?:,?\\s+(\\d{4}))?\\b`,
            "i"
        )
    );
    if (!match) return null;

    const [, startMonth, startDay, endMonth, endDay, year] = match;
    if (year) {
        const start = formatDateKey(year, startMonth, startDay);
        const end = formatDateKey(year, endMonth, endDay);
        return start && end
            ? {
                  start: { kind: "date", key: start },
                  end: { kind: "date", key: end },
              }
            : null;
    }

    const start = formatMonthDay(startMonth, startDay);
    const end = formatMonthDay(endMonth, endDay);
    return start && end
        ? {
              start: { kind: "monthDay", key: start },
              end: { kind: "monthDay", key: end },
          }
        : null;
}

function parseCompactDayRangeSameMonth(text) {
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const match = String(text || "").match(
        new RegExp(
            `\\b(?:[a-z]{2,9}\\s+)?${day}\\s*-\\s*(?:[a-z]{2,9}\\s+)?${day}\\s+${monthName}\\.?(?:,?\\s+(\\d{4}))?\\b`,
            "i"
        )
    );
    if (!match) return null;

    const [, startDay, endDay, monthNameValue, year] = match;
    if (year) {
        const start = formatDateKey(year, monthNameValue, startDay);
        const end = formatDateKey(year, monthNameValue, endDay);
        return start && end
            ? {
                  start: { kind: "date", key: start },
                  end: { kind: "date", key: end },
              }
            : null;
    }

    const start = formatMonthDay(monthNameValue, startDay);
    const end = formatMonthDay(monthNameValue, endDay);
    return start && end
        ? {
              start: { kind: "monthDay", key: start },
              end: { kind: "monthDay", key: end },
          }
        : null;
}

function parseDateRangePart(value) {
    const fullDate = parseStructuredDateKey(value);
    if (fullDate) return { kind: "date", key: fullDate };

    const monthDay = parseMonthDayKey(value);
    if (monthDay) return { kind: "monthDay", key: monthDay };

    return null;
}

function inferDateRangeYears(range) {
    if (range.start.kind === "date" && range.end.kind === "monthDay") {
        return {
            start: range.start,
            end: datePartFromMonthDay(range.end, range.start.key.slice(0, 4)),
        };
    }

    if (range.start.kind === "monthDay" && range.end.kind === "date") {
        return {
            start: datePartFromMonthDay(range.start, range.end.key.slice(0, 4)),
            end: range.end,
        };
    }

    return range;
}

function datePartFromMonthDay(part, year) {
    const [month, day] = String(part.key || "").split("-");
    return validDateParts(year, month, day)
        ? { kind: "date", key: `${year}-${month}-${day}` }
        : part;
}

function dateLooksLikeRange(value) {
    const text = normalizeJudgeText(value).replace(
        /\b\d{4}-\d{2}-\d{2}\b/g,
        ""
    );
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    return (
        /\b(?:to|until)\b/i.test(text) ||
        /\s+-\s+/.test(text) ||
        new RegExp(
            `\\b${monthName}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*-\\s*(?:${monthName}|\\d{1,2})`,
            "i"
        ).test(text) ||
        new RegExp(
            `\\b\\d{1,2}(?:st|nd|rd|th)?\\s*-\\s*(?:[a-z]{2,9}\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+${monthName}\\b`,
            "i"
        ).test(text)
    );
}

function parseNaturalMonthDayYear(text) {
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const year = "(\\d{4})";
    const monthFirst = new RegExp(
        `\\b${monthName}\\.?\\s+${day},?\\s+${year}\\b`,
        "i"
    );
    const dayFirst = new RegExp(
        `\\b${day}\\s+${monthName}\\.?\\s+${year}\\b`,
        "i"
    );
    const match = text.match(monthFirst);
    if (match) return formatDateKey(match[3], match[1], match[2]);

    const reverseMatch = text.match(dayFirst);
    if (reverseMatch) {
        return formatDateKey(reverseMatch[3], reverseMatch[2], reverseMatch[1]);
    }

    return "";
}

function formatDateKey(yearValue, monthName, dayValue) {
    const month = MONTH_INDEXES.get(String(monthName || "").toLowerCase());
    const day = String(Number(dayValue)).padStart(2, "0");
    return validDateParts(yearValue, month, day)
        ? `${yearValue}-${month}-${day}`
        : "";
}

function validDateParts(yearValue, monthValue, dayValue) {
    const year = Number(yearValue);
    const month = Number(monthValue);
    const day = Number(dayValue);
    if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        !Number.isInteger(day) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
    ) {
        return false;
    }

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= daysInMonth;
}

function parseNumericDateKey(text) {
    const match = String(text || "").match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
    if (!match) return "";

    let month = Number(match[1]);
    let day = Number(match[2]);
    const year = match[3];
    if (month > 12 && day <= 12) {
        [month, day] = [day, month];
    }

    const monthText = String(month).padStart(2, "0");
    const dayText = String(day).padStart(2, "0");
    return validDateParts(year, monthText, dayText)
        ? `${year}-${monthText}-${dayText}`
        : "";
}

function parseTimeRange(value) {
    const text = String(value || "")
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    const timePattern =
        "(\\d{1,2}(?:(?::|\\.)\\d{2})?\\s*(?:[ap](?:\\.?m\\.?)?)?)";
    const zonePattern = "(?:\\s*[a-z]{2,5})?";
    const match = text.match(
        new RegExp(
            `\\b${timePattern}${zonePattern}\\s*(?:-|to|until)\\s*${timePattern}${zonePattern}\\b`,
            "i"
        )
    );
    if (!match) return null;

    const endMeridiem = meridiemOf(match[2]);
    const start = timeMinutes(
        endMeridiem && !meridiemOf(match[1])
            ? `${match[1]} ${endMeridiem}`
            : match[1]
    );
    const end = timeMinutes(match[2]);
    if (start === null || end === null) return null;
    return { start, end };
}

function timeLooksLikeRange(value) {
    const text = String(value || "")
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    return /\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?(?:\s*[a-z]{2,5})?\s*(?:-|to|until)\s*\d{1,2}/i.test(
        text
    );
}

function meridiemOf(value) {
    return String(value || "")
        .match(/\b([ap])\.?m\.?\b/i)?.[1]
        ?.toLowerCase();
}

function timeMinutes(value) {
    const match = String(value || "")
        .trim()
        .match(/^(\d{1,2})(?:(?::|\.)(\d{2}))?\s*([ap])?\.?m?\.?$/i);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = match[3]?.toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) {
        return null;
    }

    if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === "a") hour = hour === 12 ? 0 : hour;
        if (meridiem === "p") hour = hour === 12 ? 12 : hour + 12;
    } else if (hour > 23) {
        return null;
    }

    return hour * 60 + minute;
}

function extractedEventSearchText(extracted) {
    return [
        extracted?.title,
        extracted?.preview,
        extracted?.startDate,
        extracted?.startTime,
        extracted?.endDate,
        extracted?.endTime,
        extracted?.location,
        extracted?.description,
        extracted?.recurrence,
        extracted?.category,
    ]
        .filter(Boolean)
        .join(" ");
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

export function buildErroredEvalPage({
    fixture,
    model,
    judgeModel,
    requests = [],
    error,
}) {
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
        requests,
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
        } else if (arg.startsWith("--concurrency=")) {
            args.concurrency = arg.slice("--concurrency=".length);
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

export async function callLLMWithTelemetry({
    transport,
    body,
    timeoutMs = 60000,
    metadata = {},
}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAtMs = performance.now();
    const startedAt = new Date().toISOString();
    let responseStartedAtMs = null;
    let responseStartedAt = null;
    let endedAtMs = null;
    let endedAt = null;
    let responseStatus = null;
    let responseStatusText = null;
    let responseText = "";
    let responseData = null;
    const transportMode = transport?.mode || null;
    const buildTelemetry = (error = null) =>
        buildLLMCallTelemetry({
            metadata,
            transportMode,
            body,
            responseStatus,
            responseStatusText,
            responseData,
            responseText,
            startedAt,
            responseStartedAt,
            endedAt,
            startedAtMs,
            responseStartedAtMs,
            endedAtMs,
            error,
        });

    try {
        const request = buildEvalTransportRequest({ transport, body });
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
        });
        responseStartedAtMs = performance.now();
        responseStartedAt = new Date().toISOString();
        responseStatus = response.status;
        responseStatusText = response.statusText;
        responseText = await response.text();
        endedAtMs = performance.now();
        endedAt = new Date().toISOString();

        if (!response.ok) {
            const error = new Error(
                `LLM eval request failed: ${response.status} ${responseText.slice(
                    0,
                    500
                )}`
            );
            error.telemetry = buildTelemetry(error);
            throw error;
        }

        try {
            responseData = JSON.parse(responseText);
        } catch (error) {
            error.telemetry = buildTelemetry(error);
            throw error;
        }

        return {
            data: responseData,
            telemetry: buildTelemetry(),
        };
    } catch (error) {
        if (endedAtMs === null) {
            endedAtMs = performance.now();
            endedAt = new Date().toISOString();
        }
        if (!error.telemetry) {
            error.telemetry = buildTelemetry(error);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
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
    concurrency = 1,
    reportPath = path.join(REAL_PAGE_FIXTURE_DIR, "llm-report.json"),
} = {}) {
    const benchmarkStartedAt = new Date().toISOString();
    const benchmarkStartedAtMs = performance.now();
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

        pages = await runWithConcurrency(fixtures, concurrency, async (fixture) => {
            const requests = [];
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
                const extractionData = await callAndRecordLLM(
                    {
                        transport: evalTransport,
                        body: extractionBody,
                        timeoutMs,
                        metadata: {
                            pageName: fixture.name,
                            variant: "current",
                            phase: "extract",
                            attempt: 1,
                        },
                    },
                    requests
                );
                const extractedEvents =
                    extractEventsFromStructuredOutput(extractionData);
                const judgeBody = buildEventJudgeRequestBody({
                    model: judgeModel,
                    fixture,
                    extractedEvents,
                });
                const judgeData = await callAndRecordLLM(
                    {
                        transport: evalTransport,
                        body: judgeBody,
                        timeoutMs,
                        metadata: {
                            pageName: fixture.name,
                            variant: "current",
                            phase: "judge",
                            attempt: 1,
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
                const page = {
                    name: fixture.name,
                    url: fixture.finalUrl || fixture.url,
                    model,
                    judgeModel,
                    expectedEventCount: fixture.expectedEvents.length,
                    extractedEventCount: extractedEvents.length,
                    ...summary,
                    extractedEvents,
                    judge,
                    requests,
                };
                console.log(
                    `${summary.passed ? "PASS" : "FAIL"} ${fixture.name} matches=${summary.matches} misses=${summary.misses} hallucinations=${summary.hallucinations}`
                );
                return page;
            } catch (error) {
                const page = buildErroredEvalPage({
                    fixture,
                    model,
                    judgeModel,
                    requests,
                    error,
                });
                console.log(`ERROR ${fixture.name} ${page.error}`);
                return page;
            }
        });
    } finally {
        cleanupDomParser();
    }

    const benchmarkEndedAt = new Date().toISOString();
    const benchmarkEndedAtMs = performance.now();
    const benchmarkTelemetry = summarizeLLMBenchmarkTelemetry(
        pages.flatMap((page) => page.requests || []),
        {
            startedAt: benchmarkStartedAt,
            endedAt: benchmarkEndedAt,
            startedAtMs: benchmarkStartedAtMs,
            endedAtMs: benchmarkEndedAtMs,
        }
    );
    const report = {
        generatedAt: new Date().toISOString(),
        model,
        judgeModel,
        concurrency: normalizeConcurrency(concurrency),
        pageCount: pages.length,
        passed: pages.every((page) => page.passed),
        benchmarkTelemetry,
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
    const concurrency = normalizeConcurrency(
        args.concurrency || process.env.EVENTY_EVAL_CONCURRENCY
    );
    const report = await runRealPageLLMEval({
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
