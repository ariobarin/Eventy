# Eventy SEO Gaps

Combined from the Codex audit and the pasted list. Product name is Eventy, and the preferred public product domain is `https://eventy.ariobarin.com/`.

## Priority 0: Product Identity

- Keep the public product name as Eventy across searchable surfaces: home page title, H1, meta description, privacy page, terms page, extension manifest, package metadata, README, Chrome Web Store title, Chrome Web Store description, support links, screenshots, and social preview assets.
- Keep SEO work under `eventy.ariobarin.com` and avoid mixed naming in public copy.

## Priority 1: Home Page Search Basics

- Replace the weak brand-only title in `docs/index.html`.
  - Current: `Eventy`
  - Example: `Eventy: AI calendar event extractor for Chrome`
  - Why: Google recommends descriptive, concise title links.

- Replace the generic meta description in `docs/index.html`.
  - Current: `Turn pages, text, and images into calendar events.`
  - Example: `Eventy is a Chrome extension that turns webpages, selected text, emails, flyers, and screenshots into Google Calendar or iCalendar events with AI.`
  - Why: Google may use the meta description as the search result snippet when it fits the page.

- Add crawlable content beyond the hero.
  - Suggested sections: scan webpages, scan selected text, scan flyers and screenshots, review events before export, Google Calendar export, iCalendar export, privacy, BYOK, and FAQ.
  - Include natural phrases such as `AI event extractor`, `Chrome extension`, `Google Calendar`, `iCalendar`, `flyer to calendar`, `image to calendar`, and `text to calendar`.

- Add a lightweight support page on the product domain.
  - Use it for troubleshooting, contact, privacy links, GitHub issue link, and Chrome Web Store support.
  - This is better for trust than sending users only to GitHub.

- Add canonical tags and meta descriptions to `privacy.html` and `terms.html`, or intentionally mark them `noindex`.

## Priority 2: Crawl And Duplicate URL Control

- Add `docs/sitemap.xml`.
  - Include canonical URLs for home, privacy, terms, and support if added.
  - Submit it in Google Search Console.

- Add a repo-controlled `docs/robots.txt` if you want deterministic behavior.
  - Current live state: `https://eventy.ariobarin.com/robots.txt` returns a Cloudflare-managed robots file.
  - Gap: it does not advertise `sitemap.xml`.
  - Also check that `https://eventy.ariobarin.com/sitemap.xml` currently returns 404 before shipping.

- Consolidate duplicate live copies.
  - Current concern: both `https://eventy.ariobarin.com/` and `https://ariobarin.github.io/Eventy/` are reachable.
  - The canonical tag helps, but a redirect from the alternate copy to the preferred domain is stronger if feasible.

- Verify the preferred domain in Google Search Console.
  - Submit sitemap.
  - Inspect the homepage URL.
  - Track indexed pages and queries after changes.

## Priority 3: Structured Data And Share Previews

- Add `SoftwareApplication` JSON-LD to the home page.
  - Include name, description, app category, operating system, browser requirements, version, price, website URL, Chrome Web Store install URL, privacy URL, support URL, and an image URL or real app screenshot URLs.
  - Do not add rating or review fields unless sourced from real public review data.

- Add Open Graph tags.
  - `og:title`
  - `og:description`
  - `og:url`
  - `og:type`
  - `og:image`

- Add Twitter card tags.
  - `twitter:card`
  - `twitter:title`
  - `twitter:description`
  - `twitter:image`

- Create and publish a real 1200x630 social preview image.
  - It should show the product result, not just a logo.
  - Use the same image for Open Graph and GitHub social preview if appropriate.

- Consider adding a web app manifest for polish.
  - This is not a major ranking factor, but it gives the product domain a more complete metadata surface.

## Priority 4: Chrome Web Store Listing

- Make the store title more descriptive if it fits Chrome Web Store constraints.
  - Current concern: the listing title is brand-only.
  - Example: `Eventy: AI Calendar Event Extractor`
  - Keep it concise and unique. Avoid keyword stuffing.

- Tighten the short summary around high-intent search terms.
  - Example: `Turn webpages, emails, flyers, and screenshots into Google Calendar or iCalendar events with AI.`

- Make the first paragraph of the long description do the most work.
  - Include Chrome extension, AI event extraction, webpages, selected text, images, Google Calendar, and iCalendar.
  - Keep the rest scannable by workflow and benefits.

- Update or reorder screenshots around the main jobs.
  - Full page scan.
  - Selected text scan.
  - Image, flyer, or screenshot scan.
  - Review and select extracted events.
  - Export to Google Calendar or iCalendar.

- Use Chrome Web Store image assets fully.
  - Add or refresh small promo tile and marquee image where available.
  - Use actual product UI, not abstract marketing art.

- Set the official URL to the product-specific domain if possible.
  - Prefer `https://eventy.ariobarin.com/` over a broad personal domain.
  - This can improve trust because Chrome shows the verified site under the listing title.

- Add UTM parameters to install links from the home page.
  - Example intent: distinguish installs from home page CTA, GitHub README, and support page.

- Use Chrome Web Store metrics as the iteration loop.
  - Track impressions, installs, uninstall rate, countries, languages, ratings, and review themes.
  - Iterate title, first paragraph, screenshots, and support copy based on those metrics.

## Priority 5: Trust, Privacy, And Conversion

- Reconcile the analytics claim.
  - Store copy says no tracking and no analytics.
  - Live pages include a Cloudflare analytics beacon.
  - Either disable the beacon or update public privacy and store wording.

- Keep privacy claims precise.
  - Distinguish extension behavior from website analytics.
  - Distinguish local browser storage from proxy and OpenRouter processing.

- Add a visible privacy and support path near install CTAs.
  - This helps users evaluate an AI extension before installing.

- Add a clear "review before adding" message.
  - This is a conversion point and a trust point for AI-generated event extraction.

## Suggested Work Order

1. Keep Eventy naming consistent across public SEO surfaces.
2. Update home title, meta description, and page content.
3. Add sitemap, robots behavior, canonical cleanup, and Search Console setup.
4. Add SoftwareApplication JSON-LD, Open Graph, Twitter card tags, and social preview image.
5. Tune Chrome Web Store title, summary, long description, screenshots, promo assets, official URL, and support URL.
6. Fix the analytics and privacy wording mismatch.
7. Start a metrics loop using Search Console and Chrome Web Store analytics.

## Reference Links

- [Google title links](https://developers.google.com/search/docs/appearance/title-link)
- [Google snippets](https://developers.google.com/search/docs/appearance/snippet)
- [Google sitemap overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
- [Google duplicate URL consolidation](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google software app structured data](https://developers.google.com/search/docs/appearance/structured-data/software-app)
- [Chrome Web Store listing guidance](https://developer.chrome.com/docs/webstore/best-listing)
- [Chrome Web Store image guidance](https://developer.chrome.com/docs/webstore/images)
- [Chrome Web Store metrics](https://developer.chrome.com/docs/webstore/metrics)
- [Chrome Web Store listing dashboard](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
