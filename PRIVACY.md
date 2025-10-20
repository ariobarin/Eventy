Effective date: 2025-10-20

Eventy processes webpage or selected text only when you use the “Scan” action. The selected text is sent to our Cloudflare Worker proxy and to OpenRouter to extract event fields (title, dates/times, location, description, optional recurrence). Depending on your Settings, Eventy either opens a prefilled Google Calendar page or creates events via the Google Calendar API after you authorize with Google.

Data handling:

-   No third‑party trackers are embedded. We do not sell or share your personal information.
-   Minimal Google scope used: https://www.googleapis.com/auth/calendar.events (create events only).
-   Tokens: Chrome Identity obtains and caches access tokens; Eventy does not store tokens on our servers.
-   Tokens are only used by the extension to call Google Calendar’s REST API and are not sent to our proxy.
-   Preferences are stored locally via chrome.storage. Event extraction results may be cached locally for UX.
-   All network traffic is over HTTPS.

Revocation:

-   You can disconnect in the extension (Settings → Disconnect) or via https://myaccount.google.com/permissions.

Contact: eventy.sup@gmail.com
