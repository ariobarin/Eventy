# Eventy Privacy Policy

Effective date: 2026-10-21

Eventy only reads a page when you start a scan.

## What is sent

When you scan, Eventy sends the following to the Eventy proxy (a Cloudflare Worker), which forwards the request to OpenRouter and the model provider it routes to:

- The page text, selected text, pasted text, or images you chose to scan
- The page URL and title, your timezone, and your browser language (used to resolve dates like "next Friday")
- A random installation ID, created on first use, used only to enforce the shared daily scan limit
- Your OpenRouter API key, if you added one (BYOK). It is passed through to OpenRouter and not stored on our servers.

We do not store scanned content on our servers, build user profiles, or sell or share personal information. The extension has no analytics or third-party trackers.

## What stays in your browser

- Settings (theme, time format, calendar type, API mode) in `chrome.storage.sync`
- Your API key, model choice, installation ID, recent scan results, and any text or images you pasted into the popup in `chrome.storage.local`

Adding events opens a prefilled Google Calendar page in a new tab or downloads an `.ics` file. Eventy never connects to your calendar account.

## Contact

eventy.sup@gmail.com
