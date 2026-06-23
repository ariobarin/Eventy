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

const MAX_TABLE_CELL_CHARS = 240;

function normalizeTableCell(s) {
    return String(s || "")
        .replace(/[\n\r]+/g, " ")
        .trim();
}

function truncateTableCell(raw, maxChars = MAX_TABLE_CELL_CHARS) {
    const cleaned = normalizeTableCell(raw);
    if (cleaned.length <= maxChars) return cleaned;
    if (maxChars <= 0) return "";
    if (maxChars <= 3) return ".".repeat(maxChars);
    return `${cleaned.slice(0, maxChars - 3).trim()}...`;
}

function quoteCsvCell(raw, maxChars = MAX_TABLE_CELL_CHARS) {
    return `"${truncateTableCell(raw, maxChars).replace(/"/g, '""')}"`;
}

function buildCsvLine(values, maxChars = Infinity) {
    const lineForCellLimit = (cellLimit) =>
        values.map((value) => quoteCsvCell(value, cellLimit)).join(",");
    const fullLine = lineForCellLimit(MAX_TABLE_CELL_CHARS);
    if (fullLine.length <= maxChars || !Number.isFinite(maxChars)) {
        return fullLine;
    }

    let low = 0;
    let high = MAX_TABLE_CELL_CHARS;
    let best = null;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const line = lineForCellLimit(mid);
        if (line.length <= maxChars) {
            best = line;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return best;
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
            const headerLine = buildCsvLine(headers, maxCharsPerSnippet);
            if (!headerLine) continue;
            csvLines.push(headerLine);
            let csvLength = csvLines[0].length;
            for (
                let ri = startIndex;
                ri < Math.min(rows.length, startIndex + maxRows);
                ri++
            ) {
                const cells = Array.from(rows[ri].querySelectorAll("td,th"));
                if (!cells.length) continue;
                const values = headers.map((_, ci) => cells[ci]?.textContent || "");
                let line = buildCsvLine(values);
                const nextLength = csvLength + 1 + line.length;
                if (nextLength > maxCharsPerSnippet) {
                    if (csvLines.length > 1) break;
                    line = buildCsvLine(
                        values,
                        Math.max(0, maxCharsPerSnippet - csvLength - 1)
                    );
                    if (!line) break;
                }
                csvLines.push(line);
                csvLength += 1 + line.length;
            }
            if (csvLines.length > 1) {
                const snippet = csvLines.join("\n");
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
const MODEL_INPUT_PRIORITY_LEAD_BLOCKS = 3;
const MODEL_INPUT_LEAD_BLOCKS = 18;
const MODEL_INPUT_TRUNCATION_NOTICE =
    "[Context shortened: source page exceeded the scan budget. Some events or details may be omitted.]";
const MODEL_INPUT_TRUNCATION_SEPARATOR = "\n\n";
const MONTH_NAME_PATTERN = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const ORDINAL_DAY_PATTERN = "\\d{1,2}(?:st|nd|rd|th)?";
const STANDALONE_DAY_WITH_YEAR_PATTERN = `${ORDINAL_DAY_PATTERN}(?:,?\\s*\\d{4})?`;
const MONTH_DATE_RANGE_PATTERN = `${MONTH_NAME_PATTERN}\\s+${ORDINAL_DAY_PATTERN}\\s*(?:-|\\u2013|\\u2014|to|through)\\s*${MONTH_NAME_PATTERN}\\s+${ORDINAL_DAY_PATTERN}(?:,\\s*\\d{4})?`;
const CONTEXT_LABEL_PATTERN =
    /^(?:date|time|when|where|venue|location|event date|event time|category|type|details|info|information)$/i;
const EVENT_TIME_PATTERN =
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/gi;
const EVENT_DETAIL_SIGNAL_PATTERN =
    /\b(event|calendar|ticket|tickets|rsvp|registration|doors|admission|presented|live|music|webinar|workshop|concert|screening|festival|meetup|lecture|panel|class|session|conference|show|performance|tour|venue|location|where|address|room|auditorium|hall|street|st\.|avenue|ave\.|road|rd\.)\b/gi;
const NOISE_KEYWORD_TITLE_EVENT_PATTERN =
    /\b(event|workshop|concert|screening|festival|meetup|lecture|panel|class|session|conference|show|performance|tour|market|opera|jazz|theater|theatre|film|movie|comedy|dance|night|party|gala|fair)\b/i;
const EVENT_DATE_PATTERN = new RegExp(
    [
        "\\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day)?\\b",
        "\\b(?:today|tonight|tomorrow|yesterday|this\\s+(?:morning|afternoon|evening|week|weekend)|next\\s+(?:week|weekend))\\b",
        `\\b${MONTH_DATE_RANGE_PATTERN}\\b`,
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
        .replace(/[ \f\v]+/g, " ")
        .replace(/\n[ \f\v]+/g, "\n")
        .replace(/[ \f\v]+\n/g, "\n")
        .replace(/\n{4,}/g, "\n\n\n")
        .trim();
}

function isMarkdownTableSeparator(line) {
    return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function hasDelimitedTableRows(text) {
    const rows = String(text || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    if (rows.length < 2) return false;

    const tabRows = rows.filter((line) => line.includes("\t")).length;
    if (tabRows >= 2) return true;

    const pipeRows = rows.filter(
        (line) => (line.match(/\|/g) || []).length >= 2
    ).length;
    if (pipeRows >= 2 && rows.some(isMarkdownTableSeparator)) return true;

    const commaRows = rows.filter(
        (line) => (line.match(/,/g) || []).length >= 2
    ).length;
    return commaRows >= 2;
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

function sourceQualityScore(text) {
    const normalized = normalizeModelText(text);
    if (!normalized) return 0;

    const lengthScore = Math.min(12, Math.floor(normalized.length / 1200));
    const signalScore = Math.min(40, collectSignalOffsets(normalized).length * 3);
    const blockScore = Math.min(
        30,
        Math.max(0, scoreBlock(normalized.slice(0, 12000)))
    );

    return lengthScore + signalScore + blockScore;
}

function hasDelimitedLeadDate(text) {
    return normalizeModelText(text)
        .slice(0, 700)
        .split("\n")
        .slice(0, 8)
        .some((line) => line.includes("|") && hasDateSignal(line));
}

function stripMarkdownLinks(text) {
    return String(text || "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function lineFingerprint(text) {
    return stripMarkdownLinks(text)
        .toLowerCase()
        .replace(/^[#>*\-\s]+/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function hasPlaceDetailSignal(text) {
    return /\b(?:venue|location|where|address|room|auditorium|hall|street|st\.|avenue|ave\.|road|rd\.|studio|theater|theatre|centre|center)\b/i.test(
        text
    );
}

function isLinkHeavyParsedContent(htmlText, renderedLength) {
    const linkCount = (htmlText.match(/\]\(/g) || []).length;
    return (
        linkCount >= 20 &&
        htmlText.length > Math.max(1200, renderedLength * 3)
    );
}

function htmlAddsMissingEventDetails(renderedText, htmlText, textScore, htmlScore) {
    if (
        renderedText.length > 5000 ||
        htmlText.length <= renderedText.length * 1.1 ||
        isLinkHeavyParsedContent(htmlText, renderedText.length) ||
        htmlScore < Math.max(12, textScore - 6)
    ) {
        return false;
    }

    const renderedFingerprint = lineFingerprint(renderedText);
    const missingDetailLines = htmlText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 4 && line.length <= 240)
        .filter((line) => !(line.match(/\]\(/g) || []).length)
        .filter((line) => !line.includes("|"))
        .map((line) => stripMarkdownLinks(line))
        .filter((plainText) => scoreBlock(plainText) >= 5)
        .filter((plainText) => {
            const fingerprint = lineFingerprint(plainText);
            return (
                fingerprint.length >= 4 &&
                !renderedFingerprint.includes(fingerprint)
            );
        });
    const missingPlaceDetailLines = missingDetailLines.filter(hasPlaceDetailSignal);

    return missingPlaceDetailLines.length >= 1;
}

function chooseRawModelContent(textContent, htmlContent) {
    if (!htmlContent) return textContent;
    if (!textContent) return htmlContent;

    const normalizedText = normalizeModelText(textContent);
    const normalizedHtml = normalizeModelText(htmlContent);
    if (!normalizedHtml) return normalizedText;
    if (!normalizedText) return normalizedHtml;

    const htmlScore = sourceQualityScore(normalizedHtml);
    const textScore = sourceQualityScore(normalizedText);
    const textLeadScore = sourceQualityScore(normalizedText.slice(0, 2200));
    const htmlLeadScore = sourceQualityScore(normalizedHtml.slice(0, 2200));
    const detailChromeMatches = (
        normalizedText.match(
            /\b(?:view details|show details|event details|see details|learn more|read more|more info(?:rmation)?)\b/gi
        ) || []
    ).length;
    const textLooksLikeDetailsChrome =
        (detailChromeMatches >= 6 &&
            normalizedHtml.length >= normalizedText.length * 0.45 &&
            htmlScore >= 16) ||
        (detailChromeMatches >= 2 &&
            normalizedHtml.length > normalizedText.length * 1.5 &&
            htmlScore >= textScore + 8);
    const htmlAddsHiddenEventDetails = htmlAddsMissingEventDetails(
        normalizedText,
        normalizedHtml,
        textScore,
        htmlScore
    );
    const textLooksLikeCollapsedDetails =
        textLooksLikeDetailsChrome ||
        htmlAddsHiddenEventDetails ||
        (normalizedText.length <= 4000 &&
            normalizedHtml.length > normalizedText.length * 3 &&
            /\b(expand all|collapse all|accordion panels?|accordion)\b/i.test(
                normalizedText
            ) &&
            htmlScore >= textScore - 15);
    const textFitsScanBudget =
        !textLooksLikeCollapsedDetails &&
        normalizedText.length <= MODEL_INPUT_MAX_CHARS &&
        textScore >= Math.max(8, htmlScore - 10);
    const textLeadIsClearlyBetter =
        !textLooksLikeCollapsedDetails &&
        normalizedText.length <= normalizedHtml.length &&
        textLeadScore >= 16 &&
        textLeadScore >= htmlLeadScore + 12;
    const textHasDelimitedLeadDate =
        normalizedText.length <= normalizedHtml.length &&
        hasDelimitedLeadDate(normalizedText) &&
        !hasDelimitedLeadDate(normalizedHtml);
    const textIsNearBudgetRenderedView =
        !textLooksLikeCollapsedDetails &&
        normalizedText.length <= MODEL_INPUT_MAX_CHARS * 1.35 &&
        normalizedHtml.length >= normalizedText.length * 0.75 &&
        textScore >= 16 &&
        textLeadScore >= 12;
    const htmlIsSparse =
        normalizedHtml.length < 1200 &&
        normalizedText.length > normalizedHtml.length * 3 &&
        textScore >= htmlScore;
    const textIsClearlyRicher =
        normalizedText.length > normalizedHtml.length * 1.6 &&
        textScore >= htmlScore + 12;
    const textIsBroaderRenderedView =
        normalizedText.length > normalizedHtml.length * 2.5 &&
        textScore >= Math.max(10, htmlScore - 6);
    const htmlIsBulkyDuplicate =
        normalizedHtml.length > MODEL_INPUT_MAX_CHARS &&
        normalizedHtml.length > normalizedText.length * 2.5 &&
        textScore >= 12;

    return textFitsScanBudget ||
        textLeadIsClearlyBetter ||
        textHasDelimitedLeadDate ||
        textIsNearBudgetRenderedView ||
        htmlIsSparse ||
        textIsClearlyRicher ||
        textIsBroaderRenderedView ||
        htmlIsBulkyDuplicate
        ? normalizedText
        : normalizedHtml;
}

function prependTruncationNotice(text, maxChars) {
    if (maxChars <= MODEL_INPUT_TRUNCATION_NOTICE.length) {
        return MODEL_INPUT_TRUNCATION_NOTICE.slice(0, maxChars).trim();
    }

    const bodyMaxChars = truncationNoticeBodyBudget(maxChars);
    const body = trimToMaxChars(text, bodyMaxChars);

    return body
        ? `${MODEL_INPUT_TRUNCATION_NOTICE}${MODEL_INPUT_TRUNCATION_SEPARATOR}${body}`
        : MODEL_INPUT_TRUNCATION_NOTICE;
}

function truncationNoticeBodyBudget(maxChars) {
    if (maxChars <= MODEL_INPUT_TRUNCATION_NOTICE.length) return 0;

    return Math.max(
        0,
        maxChars -
            MODEL_INPUT_TRUNCATION_NOTICE.length -
            MODEL_INPUT_TRUNCATION_SEPARATOR.length
    );
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
        /\b(event|calendar|ticket|tickets|rsvp|registration|doors|admission|presented|live|music|webinar|workshop|concert|screening|festival|meetup|lecture|panel|class|session|conference|show|performance|tour)\b/i.test(
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
        /\b(manage cookies?|cookies?|privacy policy|terms of use|terms and conditions|subscribe|newsletter|login|signin|signup|account|cart|copyright|all rights reserved|skip to content|navigation)\b/i.test(
            text
        ) ||
        (linkCount > 2 && text.length < 220)
    );
}

function addCandidate(candidates, blocks, index, priority, options = {}) {
    if (index < 0 || index >= blocks.length) return;
    const block = blocks[index];
    if (
        !block ||
        (!options.allowLikelyNoise &&
            isLikelyNoiseBlock(block.content, block.score))
    ) {
        return;
    }

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

function isCleanCompactContextBlock(
    text,
    maxLength,
    allowTerminalPunctuation = false,
    options = {}
) {
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
        !options.allowNoiseKeywords &&
        /\b(manage cookies?|cookies?|privacy policy|terms of use|subscribe|newsletter|login|account|copyright|navigation)\b/i.test(
            trimmed
        )
    ) {
        return false;
    }

    return true;
}

function isLikelyTitleContextBlock(text) {
    const trimmed = String(text || "").trim();
    if (
        !isCleanCompactContextBlock(trimmed, 220, true, {
            allowNoiseKeywords: true,
        })
    ) {
        return false;
    }
    if (CONTEXT_LABEL_PATTERN.test(trimmed)) return false;
    if (
        /\b(privacy policy|terms of use|terms and conditions|newsletter|login|signin|signup|account|cart|copyright|all rights reserved|skip to content|navigation)\b/i.test(
            trimmed
        )
    ) {
        return false;
    }
    if (/^(cookie|cookies|subscribe)$/i.test(trimmed)) return false;
    if (/\bmanage\s+cookies?\b/i.test(trimmed)) return false;
    if (
        /\bcookie(s)?\s+(settings|preferences|notice|policy|banner|consent|center|centre)\b/i.test(
            trimmed
        )
    ) {
        return false;
    }
    if (
        /\bcookies?\b/i.test(trimmed) &&
        !NOISE_KEYWORD_TITLE_EVENT_PATTERN.test(trimmed)
    ) {
        return false;
    }
    if (
        /\bsubscribe\s+(for|to our|for our|now|today)\b/i.test(trimmed) ||
        /\bsubscribe\s+(?:to\s+)?(?:updates?|newsletter|alerts?|emails?)\b/i.test(
            trimmed
        ) ||
        /^subscribe\s+to\s+.*\b(?:calendar|events?|mailing lists?|list|updates?|newsletter|alerts?|emails?|ical|ics|outlook|apple|google|yahoo|rss|feed)\b/i.test(
            trimmed
        )
    ) {
        return false;
    }
    if (
        /^subscribe\b/i.test(trimmed) &&
        !/^[Ss]ubscribe\s+to\s+[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*){0,5}$/.test(
            trimmed
        )
    ) {
        return false;
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 28 || !/[a-z]/i.test(trimmed)) {
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
            addCandidate(candidates, blocks, index - 1, priority + 1, {
                allowLikelyNoise: true,
            });
        }
        if (
            isCompactContextBridgeBlock(previousBlock) &&
            isLikelyTitleContextBlock(blocks[index - 2]?.content)
        ) {
            addCandidate(candidates, blocks, index - 2, priority + 1, {
                allowLikelyNoise: true,
            });
        }
        addCandidate(candidates, blocks, index, priority);
        addCandidate(candidates, blocks, index + 1, priority);
        addCandidate(candidates, blocks, index + 2, priority - 1);
        addCandidate(candidates, blocks, index + 3, priority - 2);
        addCandidate(candidates, blocks, index + 4, priority - 3);
    }
}

function addTitleContextBeforeSignal(candidates, blocks, index, priority) {
    const previousBlock = blocks[index - 1]?.content;
    if (isLikelyTitleContextBlock(previousBlock)) {
        addCandidate(candidates, blocks, index - 1, priority, {
            allowLikelyNoise: true,
        });
    }
    if (
        isCompactContextBridgeBlock(previousBlock) &&
        isLikelyTitleContextBlock(blocks[index - 2]?.content)
    ) {
        addCandidate(candidates, blocks, index - 2, priority, {
            allowLikelyNoise: true,
        });
    }
}

function condenseContent(text, maxChars = MODEL_INPUT_MAX_CHARS) {
    const normalizedInput = normalizeModelText(text);
    if (!normalizedInput) return "";
    if (normalizedInput.length <= maxChars) {
        return normalizedInput;
    }

    const rawBlocks = splitContentBlocks(normalizedInput);

    if (!rawBlocks.length) return "";

    const normalized = rawBlocks.join("\n\n");
    if (normalized.length <= maxChars) {
        return normalized;
    }

    const compactBudget = truncationNoticeBodyBudget(maxChars);
    if (compactBudget <= 0) return prependTruncationNotice("", maxChars);

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
            addTitleContextBeforeSignal(
                candidates,
                blocks,
                block.index,
                block.score + 9
            );
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
        const block = blocks[index];
        const priority =
            index < MODEL_INPUT_PRIORITY_LEAD_BLOCKS || block.score > 0
                ? MODEL_INPUT_SIGNAL_SCORE + 36
                : 4;
        addCandidate(candidates, blocks, index, priority);
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
        if (selectedLength + addition > compactBudget && selected.size) continue;

        selected.add(index);
        selectedLength += addition;
        if (selectedLength >= compactBudget) break;
    }

    if (!selected.size) selected.add(0);

    const compact = Array.from(selected)
        .sort((a, b) => a - b)
        .map((index) => blocks[index].content)
        .join("\n\n");

    return prependTruncationNotice(compact, maxChars);
}

export function buildModelInput(text, html, maxChars = MODEL_INPUT_MAX_CHARS) {
    const textContent = String(text || "");
    let htmlContent = "";
    const hasHtml = html && typeof html === "string" && html.trim();
    const canParseHtml = hasHtml && typeof DOMParser !== "undefined";

    // Prefer HTML path when available, converting to Markdown
    if (canParseHtml) {
        htmlContent = htmlToMarkdown(html);
    }

    const rawContent = chooseRawModelContent(
        textContent,
        htmlContent || (hasHtml && !canParseHtml ? String(html) : "")
    );

    return condenseContent(rawContent, maxChars);
}
