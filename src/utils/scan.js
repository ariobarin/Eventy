import {
    buildModelInput,
    MODEL_INPUT_MAX_CHARS,
    parseHtml,
    tablesToCsvSnippets,
} from "../llm/preprocess.js";

const TABLE_HEAVY_MIN_MODEL_CHARS = 6000;
const TABLE_CSV_MAX_CHARS =
    MODEL_INPUT_MAX_CHARS - TABLE_HEAVY_MIN_MODEL_CHARS;

function csvChars(csvSnippets) {
    return csvSnippets.reduce((sum, csv) => sum + csv.length, 0);
}

function contextSeparatorChars(csvSnippets) {
    return csvSnippets.length;
}

function clipCsvSnippetToBudget(snippet, maxChars) {
    if (snippet.length <= maxChars) return snippet;

    const lines = snippet.split("\n");
    const selected = [];
    let selectedChars = 0;
    for (const line of lines) {
        const addition = line.length + (selected.length ? 1 : 0);
        if (selectedChars + addition > maxChars) break;
        selected.push(line);
        selectedChars += addition;
    }

    return selected.length > 1 ? selected.join("\n") : "";
}

function fitCsvSnippetsToBudget(csvSnippets) {
    const fitted = [];
    let remaining = TABLE_CSV_MAX_CHARS;

    for (const snippet of csvSnippets) {
        if (remaining <= 0) break;
        const clipped = clipCsvSnippetToBudget(snippet, remaining);
        if (!clipped) continue;
        fitted.push(clipped);
        remaining -= clipped.length;
    }

    return fitted;
}

function modelBudgetForCsv(csvSnippets) {
    return Math.max(
        0,
        MODEL_INPUT_MAX_CHARS -
            csvChars(csvSnippets) -
            contextSeparatorChars(csvSnippets)
    );
}

export function preprocessForPopup(text, html) {
    // Parse once. Tables are read first because buildModelInput strips
    // noisy containers from the document, and tables inside them still count.
    const doc = html && typeof html === "string" && html.trim() ? parseHtml(html) : null;
    const source = doc || html;
    const csvSnippets = fitCsvSnippetsToBudget(tablesToCsvSnippets(source));
    const modelHtml = buildModelInput(text, source, modelBudgetForCsv(csvSnippets));
    return { modelHtml, csvSnippets };
}

export function preprocessForBackground(selectionText) {
    const modelHtml = buildModelInput(selectionText, undefined);
    return { modelHtml, csvSnippets: [] };
}
