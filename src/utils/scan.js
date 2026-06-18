import { buildModelInput, tablesToCsvSnippets } from "../llm/preprocess.js";

export function preprocessForPopup(text, html) {
    const modelHtml = buildModelInput(text, html);
    // IMPORTANT: Extract tables from RAW HTML to avoid losing tables
    // that reside in containers filtered out by modelHtml heuristics.
    const csvSnippets = tablesToCsvSnippets(html);
    return { modelHtml, csvSnippets };
}

export function preprocessForBackground(selectionText) {
    const modelHtml = buildModelInput(selectionText, undefined);
    return { modelHtml, csvSnippets: [] };
}
