export function normalizeConcurrency(value, { max = 16 } = {}) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, max);
}

export async function runWithConcurrency(items, concurrency, worker) {
    const limit = normalizeConcurrency(concurrency);
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(
        Array.from({ length: workerCount }, () => runWorker())
    );
    return results;
}
