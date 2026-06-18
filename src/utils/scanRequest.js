export function shouldCacheScanRequest(request) {
    return request?.cacheResults !== false;
}
