import fs from "node:fs/promises";
import path from "node:path";

import {
    auditRealPageFixtures,
    formatAuditLine,
    installNodeDomParser,
    loadRealPageAuditFixtures,
    REAL_PAGE_FIXTURE_DIR,
} from "./real-page-fixtures.mjs";

async function main() {
    const cleanupDomParser = await installNodeDomParser();
    try {
        const fixtures = await loadRealPageAuditFixtures();
        if (!fixtures.length) {
            throw new Error(
                "No real-page fixtures found. Run npm run capture:real-pages first."
            );
        }

        const audit = auditRealPageFixtures(fixtures);
        for (const page of audit.pages) {
            console.log(formatAuditLine(page));
        }

        await fs.mkdir(REAL_PAGE_FIXTURE_DIR, { recursive: true });
        const reportPath = path.join(REAL_PAGE_FIXTURE_DIR, "report.json");
        await fs.writeFile(reportPath, JSON.stringify(audit, null, 2));
        console.log(`report=${path.relative(process.cwd(), reportPath)}`);

        if (!audit.passed) {
            process.exitCode = 1;
        }
    } finally {
        cleanupDomParser();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
