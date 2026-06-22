// Public v1.1.1-era preprocessing used as a comparison baseline.

function chooseContentRoot(doc) {
    return (
        doc.querySelector(
            "main, article, [role='main'], #content, .content, .main-content, .page-content, .entry-content"
        ) ||
        doc.body ||
        doc.documentElement
    );
}

function removeNoisyElements(doc) {
    try {
        const removeSelectors = [
            "script",
            "style",
            "noscript",
            "template",
            "iframe",
            "canvas",
            "svg",
            "picture",
            "source",
            "object",
            "embed",
            "form",
            "input",
            "select",
            "textarea",
            "button",
            "link",
            "meta",
            "aside",
        ];

        const attrNeedles = [
            "nav",
            "navbar",
            "header",
            "footer",
            "sidebar",
            "menu",
            "breadcrumbs",
            "breadcrumb",
            "pagination",
            "pager",
            "cookie",
            "consent",
            "subscribe",
            "newsletter",
            "ad-",
            "ads",
            "advert",
            "promo",
            "banner",
            "brand",
            "logo",
            "share",
            "social",
            "search",
            "login",
            "signin",
            "signup",
            "account",
            "cart",
            "sticky",
            "floating",
            "related",
            "comments",
        ];

        const noisyAttrSelectors = attrNeedles.flatMap((needle) => [
            `[class*="${needle}"]`,
            `[id*="${needle}"]`,
            `[aria-label*="${needle}"]`,
        ]);
        const allSelectors = [...removeSelectors, ...noisyAttrSelectors].join(",");

        doc.querySelectorAll(allSelectors).forEach((el) => {
            const isTagMatch = removeSelectors.includes(el.tagName.toLowerCase());
            if (
                !isTagMatch &&
                (el.querySelector("table") ||
                    el.querySelector("h1,h2,h3,h4,h5,h6"))
            ) {
                return;
            }
            el.remove();
        });
    } catch {}
}

function convertElementToMarkdown(node) {
    if (!node) return "";

    const processChildren = (n) =>
        Array.from(n.childNodes).map(convertElementToMarkdown).join("");

    if (node.nodeType === 3) {
        return (node.nodeValue || "").replace(/\s+/g, " ");
    }

    if (node.nodeType !== 1) return "";

    const tag = node.tagName.toLowerCase();

    if (["strong", "b"].includes(tag)) {
        return ` **${processChildren(node).trim()}** `;
    }
    if (["em", "i"].includes(tag)) {
        return ` *${processChildren(node).trim()}* `;
    }
    if (tag === "code") return ` \`${processChildren(node).trim()}\` `;
    if (tag === "a") {
        const text = processChildren(node).trim();
        const href = node.getAttribute("href");
        return href && text ? ` [${text}](${href}) ` : text;
    }
    if (tag === "br") return "\n";
    if (tag === "img") return "";

    let content = processChildren(node).trim();
    if (!content && !["hr", "td", "th"].includes(tag)) return "";

    switch (tag) {
        case "h1":
            return `\n\n# ${content}\n\n`;
        case "h2":
            return `\n\n## ${content}\n\n`;
        case "h3":
            return `\n\n### ${content}\n\n`;
        case "h4":
            return `\n\n#### ${content}\n\n`;
        case "h5":
            return `\n\n##### ${content}\n\n`;
        case "h6":
            return `\n\n###### ${content}\n\n`;
        case "p":
            return `\n\n${content}\n\n`;
        case "ul":
        case "ol":
            return `\n\n${content}\n\n`;
        case "li":
            return `\n- ${content}`;
        case "blockquote":
            return `\n\n> ${content}\n\n`;
        case "pre":
            return `\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
        case "hr":
            return "\n\n---\n\n";
        case "table":
            return `\n\n${content}\n\n`;
        case "tr":
            return `| ${content} |\n`;
        case "th":
        case "td":
            return ` ${content} |`;
        default:
            return ` ${content} `;
    }
}

export function legacyHtmlToMarkdown(htmlInput) {
    try {
        if (typeof DOMParser === "undefined") {
            return htmlInput || "";
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(String(htmlInput || ""), "text/html");

        removeNoisyElements(doc);
        const contentRoot = chooseContentRoot(doc);
        const md = convertElementToMarkdown(contentRoot);

        return md.replace(/\n{3,}/g, "\n\n").trim();
    } catch {
        return String(htmlInput || "");
    }
}

export function legacyTablesToCsvSnippets(htmlInput, maxTables = 3, maxRows = 30) {
    try {
        if (typeof DOMParser === "undefined") return [];

        const parser = new DOMParser();
        const doc = parser.parseFromString(String(htmlInput || ""), "text/html");
        const tables = Array.from(doc.querySelectorAll("table"));
        const snippets = [];
        const quote = (s) =>
            `"${String(s || "")
                .replace(/"/g, '""')
                .replace(/[\n\r]+/g, " ")
                .trim()}"`;

        for (let ti = 0; ti < Math.min(tables.length, maxTables); ti++) {
            const t = tables[ti];
            const rows = Array.from(t.querySelectorAll("tr"));
            if (!rows.length) continue;
            let headerCells = Array.from(t.querySelectorAll("thead tr th"));
            if (!headerCells.length) {
                headerCells = Array.from(rows[0]?.querySelectorAll("th,td") || []);
            }
            const headers = headerCells
                .map((c, i) => c.textContent || `col${i + 1}`)
                .map((s) => s.trim());
            const startIndex =
                headerCells.length && rows[0]?.contains(headerCells[0]) ? 1 : 0;
            const csvLines = [headers.map(quote).join(",")];

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
    } catch {
        return [];
    }
}

function scoreBlock(text) {
    let score = 0;
    const dateMatches = (
        text.match(
            /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}|(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})/gi
        ) || []
    ).length;
    score += dateMatches * 10;

    const timeMatches = (
        text.match(/\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)/gi) ||
        []
    ).length;
    score += timeMatches * 10;

    if (/venue|location|where|address|host|present|live|webinar/i.test(text)) {
        score += 5;
    }

    const linkCount = (text.match(/\]\(/g) || []).length;
    if (linkCount > 3 && text.length < 200) score -= 5;

    return score;
}

function condenseContent(text, maxChars = 80000) {
    if (!text || text.length <= maxChars) return text;

    const blocks = text.split(/\n\s*\n/);
    const scoredBlocks = blocks.map((content, index) => ({
        content,
        index,
        score: scoreBlock(content),
        length: content.length,
    }));

    scoredBlocks.sort((a, b) => b.score - a.score);

    let currentLength = 0;
    const selectedBlocks = [];
    for (const block of scoredBlocks) {
        if (currentLength + block.length > maxChars) continue;
        selectedBlocks.push(block);
        currentLength += block.length;
        if (currentLength >= maxChars) break;
    }

    selectedBlocks.sort((a, b) => a.index - b.index);
    return selectedBlocks.map((block) => block.content).join("\n\n");
}

export function buildLegacyModelInput(text, html) {
    const rawContent =
        html && typeof html === "string" && html.trim()
            ? legacyHtmlToMarkdown(html)
            : String(text || "");

    return condenseContent(rawContent, 80000);
}

export function preprocessLegacyForPopup(text, html) {
    return {
        modelHtml: buildLegacyModelInput(text, html),
        csvSnippets: legacyTablesToCsvSnippets(html),
    };
}
