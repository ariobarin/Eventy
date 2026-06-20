const FRONT_BASE_PATH = "/eventy-home";
const FRONT_CANONICAL_HOSTNAME = "eventy.ariobarin.com";
const UPSTREAM_ORIGIN = "https://ariobarin.github.io";
const UPSTREAM_BASE_PATH = "/Eventy";

function upstreamUrlForSuffix(suffix, search) {
    const upstream = new URL(`${UPSTREAM_BASE_PATH}${suffix}`, UPSTREAM_ORIGIN);
    upstream.search = search;
    return { upstreamUrl: upstream.toString() };
}

export function upstreamUrlForEventyHome(requestUrl) {
    const url = new URL(requestUrl);

    if (url.hostname === FRONT_CANONICAL_HOSTNAME) {
        return upstreamUrlForSuffix(url.pathname, url.search);
    }

    if (url.pathname === FRONT_BASE_PATH) {
        url.pathname = `${FRONT_BASE_PATH}/`;
        return { redirectUrl: url.toString() };
    }

    if (!url.pathname.startsWith(`${FRONT_BASE_PATH}/`)) {
        return null;
    }

    const suffix = url.pathname.slice(FRONT_BASE_PATH.length);
    return upstreamUrlForSuffix(suffix, url.search);
}

export default {
    async fetch(request) {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("Method Not Allowed", {
                status: 405,
                headers: { Allow: "GET, HEAD" },
            });
        }

        const route = upstreamUrlForEventyHome(request.url);
        if (!route) {
            return new Response("Not Found", { status: 404 });
        }

        if (route.redirectUrl) {
            return Response.redirect(route.redirectUrl, 301);
        }

        return fetch(new Request(route.upstreamUrl, request));
    },
};
