import { escapeHtml } from "../utils/string.js";

// Heuristic HTML filtering
function chooseContentRoot(doc) {
    return (
        doc.querySelector(
            "main, article, [role='main'], #content, .main-content, .page-content, .entry-content"
        ) || doc.body || doc.documentElement
    );
}

function removeNoisyElements(doc) {
    try {
        const removeSelectors = [
            // Tags that never carry useful text for our use-case
            "script", "style", "noscript", "template", "iframe", "canvas",
            "svg", "picture", "source", "object", "embed",
            "form", "input", "select", "textarea", "button",
            "link", "meta",
            // Common layout/auxiliary regions
            "aside",
        ];

        const attrNeedles = [
            // Navigation / chrome
            "nav", "navbar", "header", "footer", "sidebar", "menu",
            "breadcrumbs", "breadcrumb", "pagination", "pager",
            // Annoyances / promos
            "cookie", "consent", "subscribe", "newsletter",
            "ad-", "ads", "advert", "promo", "banner", "brand", "logo",
            // Social/share
            "share", "social",
            // Account / search / commerce
            "search", "login", "signin", "signup", "account", "cart",
            // Misc chrome
            "sticky", "floating", "related", "comments",
        ];

        // Optimize selector generation
        const noisyAttrSelectors = attrNeedles.flatMap(needle => [
            `[class*="${needle}"]`,
            `[id*="${needle}"]`,
            `[aria-label*="${needle}"]`
        ]);

        // Combine all selectors into one query
        const allSelectors = [...removeSelectors, ...noisyAttrSelectors].join(",");

        doc.querySelectorAll(allSelectors).forEach((el) => {
            // Be conservative: only remove if it doesn't contain tables or headings
            const isTagMatch = removeSelectors.includes(el.tagName.toLowerCase());
            if (!isTagMatch && (el.querySelector("table") || el.querySelector("h1,h2,h3,h4,h5,h6"))) {
                return;
            }
            el.remove();
        });
    } catch (_) { }
}


function convertElementToMarkdown(node) {
    if (!node) return "";

    // Helper to process children
    const processChildren = (n) => {
        return Array.from(n.childNodes)
            .map(convertElementToMarkdown)
            .join("");
    };

    if (node.nodeType === 3) { // Text node
        // Normalize whitespace but keep it (inline)
        return (node.nodeValue || "").replace(/\s+/g, " ");
    }

    if (node.nodeType !== 1) return ""; // Skip comments, etc.

    const tag = node.tagName.toLowerCase();

    // Handle inline elements
    if (['strong', 'b'].includes(tag)) return ` **${processChildren(node).trim()}** `;
    if (['em', 'i'].includes(tag)) return ` *${processChildren(node).trim()}* `;
    if (tag === 'code') return ` \`${processChildren(node).trim()}\` `;
    if (tag === 'a') {
        const text = processChildren(node).trim();
        const href = node.getAttribute('href');
        return href && text ? ` [${text}](${href}) ` : text;
    }
    if (tag === 'br') return "\n";
    if (tag === 'img') {
        // Skip images in markdown for now unless critical, but maybe useful for context?
        // LLM has image input separately, so we can ignore images in text mostly.
        return "";
    }

    // Handle block elements
    let content = processChildren(node);

    // trimming content for blocks
    content = content.trim();

    if (!content && !['hr', 'td', 'th'].includes(tag)) return "";

    switch (tag) {
        case 'h1': return `\n\n# ${content}\n\n`;
        case 'h2': return `\n\n## ${content}\n\n`;
        case 'h3': return `\n\n### ${content}\n\n`;
        case 'h4': return `\n\n#### ${content}\n\n`;
        case 'h5': return `\n\n##### ${content}\n\n`;
        case 'h6': return `\n\n###### ${content}\n\n`;
        case 'p': return `\n\n${content}\n\n`;
        case 'ul': return `\n\n${content}\n\n`;
        case 'ol': return `\n\n${content}\n\n`;
        case 'li': return `\n- ${content}`;
        case 'blockquote': return `\n\n> ${content}\n\n`;
        case 'pre': return `\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
        case 'hr': return `\n\n---\n\n`;
        case 'table': return `\n\n${content}\n\n`; // simplified, assuming we handle tables elsewhere or just dump text
        case 'tr': return `| ${content} |\n`;
        case 'th':
        case 'td': return ` ${content} |`;
        // Structural divs just return content
        default: return ` ${content} `;
    }
}

export function htmlToMarkdown(htmlInput) {
    try {
        // Check availability of DOMParser
        if (typeof DOMParser === 'undefined') {
            console.warn("DOMParser not available, returning raw HTML");
            return htmlInput || "";
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(String(htmlInput || ""), "text/html");

        removeNoisyElements(doc);
        const contentRoot = chooseContentRoot(doc);

        let md = convertElementToMarkdown(contentRoot);

        // Post-processing cleanup
        return md
            .replace(/\n{3,}/g, "\n\n") // Max 2 newlines
            .trim();
    } catch (e) {
        console.error("Markdown conversion failed", e);
        return String(htmlInput || "");
    }
}

function trimCsvSnippet(snippet, maxChars) {
    if (snippet.length <= maxChars) return snippet;

    const clipped = snippet.slice(0, maxChars);
    const lineBreak = clipped.lastIndexOf("\n");
    const trimmed =
        lineBreak > maxChars * 0.5 ? clipped.slice(0, lineBreak) : clipped;

    return trimmed.trim();
}

export function tablesToCsvSnippets(
    htmlInput,
    maxTables = 3,
    maxRows = 30,
    maxCharsPerSnippet = 6000
) {
    try {
        if (typeof DOMParser === 'undefined') return [];

        const parser = new DOMParser();
        const doc = parser.parseFromString(
            String(htmlInput || ""),
            "text/html"
        );
        const tables = Array.from(doc.querySelectorAll("table"));
        const snippets = [];
        const cleanCell = (s) => {
            const cleaned = String(s || "")
                .replace(/[\n\r]+/g, " ")
                .trim();
            const truncated = cleaned.length > 240
                ? `${cleaned.slice(0, 237).trim()}...`
                : cleaned;
            return truncated.replace(/"/g, '""');
        };
        const quote = (s) => '"' + cleanCell(s) + '"';
        for (let ti = 0; ti < Math.min(tables.length, maxTables); ti++) {
            const t = tables[ti];
            const rows = Array.from(t.querySelectorAll("tr"));
            if (!rows.length) continue;
            let headerCells = Array.from(t.querySelectorAll("thead tr th"));
            if (!headerCells.length)
                headerCells = Array.from(
                    rows[0]?.querySelectorAll("th,td") || []
                );
            const headers = headerCells
                .map((c, i) => c.textContent || `col${i + 1}`)
                .map((s) => s.trim());
            const startIndex =
                headerCells.length && rows[0]?.contains(headerCells[0]) ? 1 : 0;
            const csvLines = [];
            csvLines.push(headers.map(quote).join(","));
            let csvLength = csvLines[0].length;
            for (
                let ri = startIndex;
                ri < Math.min(rows.length, startIndex + maxRows);
                ri++
            ) {
                const cells = Array.from(rows[ri].querySelectorAll("td,th"));
                if (!cells.length) continue;
                const values = headers.map((_, ci) =>
                    quote(cells[ci]?.textContent || "")
                );
                const line = values.join(",");
                const nextLength = csvLength + 1 + line.length;
                if (nextLength > maxCharsPerSnippet && csvLines.length > 1) {
                    break;
                }
                csvLines.push(line);
                csvLength = nextLength;
            }
            if (csvLines.length > 1) {
                const snippet = trimCsvSnippet(
                    csvLines.join("\n"),
                    maxCharsPerSnippet
                );
                if (snippet) snippets.push(snippet);
            }
        }
        return snippets;
    } catch (_) {
        return [];
    }
}

export const MODEL_INPUT_MAX_CHARS = 18000;

const MODEL_INPUT_MAX_BLOCK_CHARS = 4000;
const MODEL_INPUT_SIGNAL_CHUNK_CHARS = 1400;
const MODEL_INPUT_SIGNAL_CHUNK_MIN_SIGNALS = 8;
const MODEL_INPUT_SIGNAL_SCORE = 8;
const MODEL_INPUT_LEAD_BLOCKS = 10;
const MODEL_INPUT_TRUNCATION_NOTICE =
    "[Context shortened: source page exceeded the scan budget. Some events or details may be omitted.]";
const MONTH_NAME_PATTERN = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const ORDINAL_DAY_PATTERN = "\\d{1,2}(?:st|nd|rd|th)?";
const STANDALONE_DAY_WITH_YEAR_PATTERN = `${ORDINAL_DAY_PATTERN}(?:,?\\s*\\d{4})?`;
const CONTEXT_LABEL_PATTERN =
    /^(?:date|time|when|where|venue|location|event date|event time|category|type|details|info|information)$/i;
const EVENT_TIME_PATTERN =
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/gi;
const EVENT_DETAIL_SIGNAL_PATTERN =
    /\b(event|calendar|ticket|tickets|rsvp|registration|doors|admission|presented|live|webinar|workshop|concert|screening|festival|meetup|lecture|panel|class|session|conference|show|performance|tour|venue|location|where|address|room|auditorium|hall|street|st\.|avenue|ave\.|road|rd\.)\b/gi;
const EVENT_DATE_PATTERN = new RegExp(
    [
        "\\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day)?\\b",
        "\\b(?:today|tonight|tomorrow|yesterday|this\\s+(?:morning|afternoon|evening|week|weekend)|next\\s+(?:week|weekend))\\b",
        `\\b${MONTH_NAME_PATTERN}\\s+${ORDINAL_DAY_PATTERN}(?:,\\s*\\d{4})?\\b`,
        `\\b${ORDINAL_DAY_PATTERN}\\s+${MONTH_NAME_PATTERN}(?:\\s+\\d{4})?\\b`,
        "\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b",
        "\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b",
    ].join("|"),
    "gi"
);
const STANDALONE_MONTH_PATTERN = new RegExp(`^${MONTH_NAME_PATTERN}$`, "i");
const STANDALONE_DAY_PATTERN = new RegExp(
    `^${STANDALONE_DAY_WITH_YEAR_PATTERN}$`,
    "i"
);

function normalizeModelText(text) {
    return String(text || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{4,}/g, "\n\n\n")
        .trim();
}

function findSignalChunkBreak(text, minEnd, maxEnd) {
    const breakWindow = text.slice(minEnd, maxEnd);
    const sentenceBreakPattern = /[.!?]\s+(?=[A-Z0-9#*])/g;
    let sentenceBreak = -1;
    let match;
    while ((match = sentenceBreakPattern.exec(breakWindow))) {
        sentenceBreak = minEnd + match.index + match[0].length;
    }
    if (sentenceBreak > minEnd) return sentenceBreak;

    const whitespaceBreak = text.lastIndexOf(" ", maxEnd);
    if (whitespaceBreak > minEnd) return whitespaceBreak + 1;

    return maxEnd;
}

function splitLongSignalParagraph(text) {
    if (text.length <= MODEL_INPUT_MAX_BLOCK_CHARS) return [text];
    if (collectSignalOffsets(text).length < MODEL_INPUT_SIGNAL_CHUNK_MIN_SIGNALS) {
        return [text];
    }

    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const remainingChars = text.length - start;
        if (remainingChars <= MODEL_INPUT_SIGNAL_CHUNK_CHARS) {
            chunks.push(text.slice(start).trim());
            break;
        }

        const minEnd = start + Math.floor(MODEL_INPUT_SIGNAL_CHUNK_CHARS * 0.65);
        const maxEnd = Math.min(text.length, start + MODEL_INPUT_SIGNAL_CHUNK_CHARS);
        const end = findSignalChunkBreak(text, minEnd, maxEnd);
        chunks.push(text.slice(start, end).trim());
        start = end;
    }

    return chunks.filter(Boolean);
}

function splitContentBlocks(text) {
    const normalized = normalizeModelText(text);
    if (!normalized) return [];

    const blocks = [];
    for (const paragraph of normalized.split(/\n\s*\n/)) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;

        const signalChunks = splitLongSignalParagraph(trimmed);
        if (signalChunks.length > 1) {
            blocks.push(...signalChunks);
            continue;
        }

        const lines = trimmed
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        const shouldSplitLines =
            lines.length > 4 ||
            (lines.length > 1 && lines.every((line) => line.length <= 180));

        if (shouldSplitLines) {
            blocks.push(...lines);
        } else {
            blocks.push(trimmed);
        }
    }

    return blocks;
}

function collectSignalOffsets(content) {
    const collectPatternOffsets = (pattern, limit) => {
        const offsets = [];
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) && offsets.length < limit) {
            offsets.push(match.index);
            if (match.index === pattern.lastIndex) pattern.lastIndex++;
        }
        pattern.lastIndex = 0;
        return offsets;
    };

    const prioritizedOffsets = [
        ...collectPatternOffsets(EVENT_DATE_PATTERN, 16),
        ...collectPatternOffsets(EVENT_TIME_PATTERN, 12),
        ...collectPatternOffsets(EVENT_DETAIL_SIGNAL_PATTERN, 8),
    ];
    const seen = new Set();
    const offsets = [];
    for (const offset of prioritizedOffsets) {
        if (!seen.has(offset)) {
            seen.add(offset);
            offsets.push(offset);
        }
    }

    return offsets;
}

function addClipSegment(segments, contentLength, start, end) {
    const safeStart = Math.max(0, Math.min(contentLength, start));
    const safeEnd = Math.max(safeStart, Math.min(contentLength, end));
    if (safeEnd > safeStart) {
        segments.push({ start: safeStart, end: safeEnd });
    }
}

function mergeClipSegments(segments) {
    const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];

    for (const segment of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && segment.start <= previous.end + 20) {
            previous.end = Math.max(previous.end, segment.end);
        } else {
            merged.push({ ...segment });
        }
    }

    return merged;
}

function spreadSignalOffsets(offsets, maxCount) {
    if (offsets.length <= maxCount) return offsets;
    if (maxCount <= 1) return [offsets[0]];

    const selected = [];
    const lastIndex = offsets.length - 1;
    for (let index = 0; index < maxCount; index++) {
        selected.push(offsets[Math.round((index * lastIndex) / (maxCount - 1))]);
    }

    return Array.from(new Set(selected));
}

function clipBlock(content) {
    if (content.length <= MODEL_INPUT_MAX_BLOCK_CHARS) return content;

    const marker = "\n...\n";
    const signalOffsets = collectSignalOffsets(content);
    if (!signalOffsets.length) {
        const availableChars = MODEL_INPUT_MAX_BLOCK_CHARS - marker.length;
        const headChars = Math.floor(availableChars * 0.55);
        const tailChars = availableChars - headChars;
        const head = content.slice(0, headChars).trim();
        const tail = content.slice(-tailChars).trim();

        return `${head}${marker}${tail}`;
    }

    const segments = [];
    addClipSegment(segments, content.length, 0, 220);
    for (const offset of spreadSignalOffsets(signalOffsets, 5)) {
        addClipSegment(segments, content.length, offset - 50, offset + 95);
    }
    addClipSegment(segments, content.length, content.length - 180, content.length);

    const selected = [];
    let usedChars = 0;
    for (const segment of mergeClipSegments(segments)) {
        const separatorChars = selected.length ? marker.length : 0;
        const remainingChars =
            MODEL_INPUT_MAX_BLOCK_CHARS - usedChars - separatorChars;
        if (remainingChars <= 80) continue;

        const segmentEnd = Math.min(segment.end, segment.start + remainingChars);
        selected.push({ start: segment.start, end: segmentEnd });
        usedChars += separatorChars + (segmentEnd - segment.start);
        if (usedChars >= MODEL_INPUT_MAX_BLOCK_CHARS) break;
    }

    return selected
        .map((segment) => content.slice(segment.start, segment.end).trim())
        .filter(Boolean)
        .join(marker);
}

function trimToMaxChars(text, maxChars) {
    if (text.length <= maxChars) return text;

    const clipped = text.slice(0, maxChars);
    const blockBreak = clipped.lastIndexOf("\n\n");
    const trimmed =
        blockBreak > maxChars * 0.75 ? clipped.slice(0, blockBreak) : clipped;

    return trimmed.trim();
}

function prependTruncationNotice(text, maxChars) {
    if (maxChars <= MODEL_INPUT_TRUNCATION_NOTICE.length) {
        return MODEL_INPUT_TRUNCATION_NOTICE.slice(0, maxChars).trim();
    }

    const separator = "\n\n";
    const bodyMaxChars =
        maxChars - MODEL_INPUT_TRUNCATION_NOTICE.length - separator.length;
    const body = trimToMaxChars(text, bodyMaxChars);

    return body
        ? `${MODEL_INPUT_TRUNCATION_NOTICE}${separator}${body}`
        : MODEL_INPUT_TRUNCATION_NOTICE;
}

// Heuristic scoring for event relevance
function scoreBlock(text) {
    let score = 0;
    // Date patterns such as Jan 21, 26 June, Friday, 2025-01-21, or 12/25.
    const dateMatches = (text.match(EVENT_DATE_PATTERN) || []).length;
    score += dateMatches * 10;

    // Time patterns such as 7:00 PM, 14:00, or 7am.
    const timeMatches = (text.match(EVENT_TIME_PATTERN) || []).length;
    score += timeMatches * 10;

    if (
        /\b(event|calendar|ticket|tickets|rsvp|registration|doors|admission|presented|live|webinar|workshop|concert|screening|festival|meetup|lecture|panel|class|session|conference|show|performance|tour)\b/i.test(
            text
        )
    ) {
        score += 5;
    }

    if (
        /\b(venue|location|where|address|room|auditorium|hall|street|st\.|avenue|ave\.|road|rd\.)\b/i.test(
            text
        )
    ) {
        score += 5;
    }

    if (/^#{1,6}\s/.test(text)) score += 2;
    if (/^\s*[-*]\s+/.test(text)) score += 1;

    // Penalty for likely noise (e.g. navigation links often have high link density relative to text length in markdown)
    // In markdown, links look like [text](url). High density of ]( relative to length suggests list of links.
    const linkCount = (text.match(/\]\(/g) || []).length;
    if (linkCount > 3 && text.length < 200) score -= 5;
    if (
        /\b(cookie|privacy policy|terms of use|terms and conditions|subscribe|newsletter|login|signin|signup|account|cart|copyright|all rights reserved|skip to content)\b/i.test(
            text
        )
    ) {
        score -= 8;
    }
    if (text.trim().length < 4) score -= 3;

    return score;
}

function isLikelyNoiseBlock(text, score) {
    if (score >= MODEL_INPUT_SIGNAL_SCORE) return false;

    const linkCount = (text.match(/\]\(/g) || []).length;
    return (
        /\b(cookie|privacy policy|terms of use|terms and conditions|subscribe|newsletter|login|signin|signup|account|cart|copyright|all rights reserved|skip to content|navigation)\b/i.test(
            text
        ) ||
        (linkCount > 2 && text.length < 220)
    );
}

function addCandidate(candidates, blocks, index, priority) {
    if (index < 0 || index >= blocks.length) return;
    const block = blocks[index];
    if (!block || isLikelyNoiseBlock(block.content, block.score)) return;

    candidates.set(index, Math.max(candidates.get(index) || 0, priority));
}

function isStandaloneMonthBlock(text) {
    return STANDALONE_MONTH_PATTERN.test(String(text || "").trim());
}

function isStandaloneDayBlock(text) {
    return STANDALONE_DAY_PATTERN.test(String(text || "").trim());
}

function hasDateSignal(text) {
    EVENT_DATE_PATTERN.lastIndex = 0;
    const result = EVENT_DATE_PATTERN.test(text);
    EVENT_DATE_PATTERN.lastIndex = 0;
    return result;
}

function isCleanCompactContextBlock(text, maxLength, allowTerminalPunctuation = false) {
    const trimmed = String(text || "").trim();
    if (!trimmed || trimmed.length > maxLength) return false;
    if (trimmed.includes("\n")) return false;
    if (hasDateSignal(trimmed)) return false;
    if (isStandaloneMonthBlock(trimmed) || isStandaloneDayBlock(trimmed)) {
        return false;
    }
    if (/[\]\[]\(|https?:\/\//i.test(trimmed)) return false;
    if (!allowTerminalPunctuation && /[.!?]$/.test(trimmed)) return false;
    if (
        /\b(cookie|privacy policy|terms of use|subscribe|newsletter|login|account|copyright|navigation)\b/i.test(
            trimmed
        )
    ) {
        return false;
    }

    return true;
}

function isLikelyTitleContextBlock(text) {
    const trimmed = String(text || "").trim();
    if (!isCleanCompactContextBlock(trimmed, 140, true)) return false;
    if (CONTEXT_LABEL_PATTERN.test(trimmed)) return false;

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 14 || !/[a-z]/i.test(trimmed)) {
        return false;
    }

    if (/[!?]$/.test(trimmed)) return true;
    if (/\.$/.test(trimmed)) return words.length <= 4;

    return true;
}

function isCompactContextBridgeBlock(text) {
    const trimmed = String(text || "").trim();
    if (!isCleanCompactContextBlock(trimmed, 80)) return false;

    const words = trimmed.split(/\s+/).filter(Boolean);
    return words.length >= 1 && words.length <= 6 && /[a-z]/i.test(trimmed);
}

function addSplitDateContext(candidates, blocks, index, priority) {
    if (
        isStandaloneDayBlock(blocks[index - 1]?.content) &&
        isStandaloneMonthBlock(blocks[index - 2]?.content)
    ) {
        addCandidate(candidates, blocks, index - 2, priority);
    }
    if (
        isStandaloneDayBlock(blocks[index - 2]?.content) &&
        isStandaloneMonthBlock(blocks[index - 3]?.content)
    ) {
        addCandidate(candidates, blocks, index - 3, priority);
    }
}

function addStandaloneMonthDayCandidates(candidates, blocks) {
    for (let index = 0; index < blocks.length - 1; index++) {
        const isMonthThenDay =
            isStandaloneMonthBlock(blocks[index]?.content) &&
            isStandaloneDayBlock(blocks[index + 1]?.content);
        const isDayThenMonth =
            isStandaloneDayBlock(blocks[index]?.content) &&
            isStandaloneMonthBlock(blocks[index + 1]?.content);

        if (!isMonthThenDay && !isDayThenMonth) {
            continue;
        }

        const priority = MODEL_INPUT_SIGNAL_SCORE + 8;
        const previousBlock = blocks[index - 1]?.content;
        if (isLikelyTitleContextBlock(previousBlock)) {
            addCandidate(candidates, blocks, index - 1, priority - 1);
        }
        if (
            isCompactContextBridgeBlock(previousBlock) &&
            isLikelyTitleContextBlock(blocks[index - 2]?.content)
        ) {
            addCandidate(candidates, blocks, index - 2, priority - 1);
        }
        addCandidate(candidates, blocks, index, priority);
        addCandidate(candidates, blocks, index + 1, priority);
        addCandidate(candidates, blocks, index + 2, priority - 1);
        addCandidate(candidates, blocks, index + 3, priority - 2);
        addCandidate(candidates, blocks, index + 4, priority - 3);
    }
}

function condenseContent(text, maxChars = MODEL_INPUT_MAX_CHARS) {
    const rawBlocks = splitContentBlocks(text);

    if (!rawBlocks.length) return "";

    const normalized = rawBlocks.join("\n\n");
    if (normalized.length <= maxChars) {
        return normalized;
    }

    const blocks = rawBlocks.map((content, index) => ({
        content: clipBlock(content),
        index,
        score: scoreBlock(content),
    }));

    const candidates = new Map();

    for (const block of blocks) {
        if (block.score >= MODEL_INPUT_SIGNAL_SCORE) {
            addCandidate(candidates, blocks, block.index - 3, block.score + 3);
            addCandidate(candidates, blocks, block.index - 2, block.score + 4);
            addCandidate(candidates, blocks, block.index - 1, block.score + 8);
            addSplitDateContext(candidates, blocks, block.index, block.score + 6);
            addCandidate(candidates, blocks, block.index, block.score + 20);
            addCandidate(candidates, blocks, block.index + 1, block.score + 8);
            addCandidate(candidates, blocks, block.index + 2, block.score + 4);
        } else if (block.score > 0) {
            addCandidate(candidates, blocks, block.index, block.score);
        }
    }
    addStandaloneMonthDayCandidates(candidates, blocks);

    for (
        let index = 0;
        index < Math.min(MODEL_INPUT_LEAD_BLOCKS, blocks.length);
        index++
    ) {
        addCandidate(candidates, blocks, index, 4);
    }

    if (!candidates.size) {
        for (let index = 0; index < blocks.length; index++) {
            addCandidate(candidates, blocks, index, 1);
            if (candidates.size >= MODEL_INPUT_LEAD_BLOCKS) break;
        }
    }

    const rankedCandidates = Array.from(candidates.entries()).sort(
        ([indexA, priorityA], [indexB, priorityB]) =>
            priorityB - priorityA || indexA - indexB
    );
    const selected = new Set();
    let selectedLength = 0;

    for (const [index] of rankedCandidates) {
        const block = blocks[index];
        const addition = block.content.length + (selected.size ? 2 : 0);
        if (selectedLength + addition > maxChars && selected.size) continue;

        selected.add(index);
        selectedLength += addition;
        if (selectedLength >= maxChars) break;
    }

    if (!selected.size) selected.add(0);

    const compact = Array.from(selected)
        .sort((a, b) => a - b)
        .map((index) => blocks[index].content)
        .join("\n\n");

    return prependTruncationNotice(compact, maxChars);
}

export function buildModelInput(text, html) {
    let rawContent = "";
    const textContent = String(text || "");

    // Prefer HTML path when available, converting to Markdown
    if (
        html &&
        typeof html === "string" &&
        html.trim() &&
        typeof DOMParser !== "undefined"
    ) {
        rawContent = htmlToMarkdown(html);
    } else {
        // Fallback to text-only when parsing is unavailable.
        rawContent = textContent || String(html || "");
    }

    return condenseContent(rawContent, MODEL_INPUT_MAX_CHARS);
}
