import { escapeHtml } from "../utils/string.js";

// Heuristic HTML filtering
function chooseContentRoot(doc) {
    return (
        doc.querySelector(
            "main, article, [role='main'], #content, .content, .main-content, .page-content, .entry-content"
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

export function tablesToCsvSnippets(htmlInput, maxTables = 3, maxRows = 30) {
    try {
        if (typeof DOMParser === 'undefined') return [];

        const parser = new DOMParser();
        const doc = parser.parseFromString(
            String(htmlInput || ""),
            "text/html"
        );
        const tables = Array.from(doc.querySelectorAll("table"));
        const snippets = [];
        const quote = (s) =>
            '"' +
            String(s || "")
                .replace(/"/g, '""')
                .replace(/[\n\r]+/g, " ")
                .trim() +
            '"';
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
                csvLines.push(values.join(","));
            }
            if (csvLines.length > 1) snippets.push(csvLines.join("\n"));
        }
        return snippets;
    } catch (_) {
        return [];
    }
}

// Heuristic scoring for event relevance
function scoreBlock(text) {
    let score = 0;
    // Date patterns (e.g., Jan 21, 2025-01-21, 12/25)
    const dateMatches = (text.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}|(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})/gi) || []).length;
    score += dateMatches * 10;

    // Time patterns (e.g., 7:00 PM, 14:00, 7am)
    const timeMatches = (text.match(/\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)/gi) || []).length;
    score += timeMatches * 10;

    // Location/Event keywords
    if (/venue|location|where|address|host|present|live|webinar/i.test(text)) score += 5;

    // Penalty for likely noise (e.g. navigation links often have high link density relative to text length in markdown)
    // In markdown, links look like [text](url). High density of ]( relative to length suggests list of links.
    const linkCount = (text.match(/\]\(/g) || []).length;
    if (linkCount > 3 && text.length < 200) score -= 5;

    return score;
}

function condenseContent(text, maxChars = 80000) {
    if (!text || text.length <= maxChars) return text;

    // Split into blocks (paragraphs, headers, list items)
    // We split by double newline to capture paragraphs, or by newline for lists if they are dense.
    // Let's stick to double newline or major structural boundaries for markdown.
    const blocks = text.split(/\n\s*\n/);

    // Map blocks to objects with score and original index
    const scoredBlocks = blocks.map((content, index) => ({
        content,
        index,
        score: scoreBlock(content),
        length: content.length
    }));

    // Sort by score descending
    scoredBlocks.sort((a, b) => b.score - a.score);

    let currentLength = 0;
    const selectedBlocks = [];

    // Select blocks until maxChars is reached
    for (const block of scoredBlocks) {
        if (currentLength + block.length > maxChars) {
            // If this meaningful block is too big but we have space, maybe take a chunk?
            // For now, simple inclusion/exclusion.
            continue;
        }
        selectedBlocks.push(block);
        currentLength += block.length;
        if (currentLength >= maxChars) break;
    }

    // Sort back to original order to preserve flow
    selectedBlocks.sort((a, b) => a.index - b.index);

    return selectedBlocks.map(b => b.content).join("\n\n");
}

export function buildModelInput(text, html) {
    let rawContent = "";

    // Prefer HTML path when available, converting to Markdown
    if (html && typeof html === "string" && html.trim()) {
        rawContent = htmlToMarkdown(html);
    } else {
        // Fallback to text-only (simple pass-through)
        rawContent = String(text || "");
    }

    // Enforce token limit (approx 20k tokens ~ 80k chars)
    return condenseContent(rawContent, 80000);
}
