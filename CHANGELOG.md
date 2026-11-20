# Changelog

## 2.0.0
- Added optional AI translation and editorial classification (category, priority, promotional flag).
- Added chunked translation for long articles with LibreTranslate, Google and MyMemory fallbacks.
- Added per-destination delivery records and retry behavior that avoids resending to channels that already succeeded.
- Added source pause/resume and manual test controls.
- Added target pause/resume and delete controls.
- Added source test metadata and recent AI analysis to the admin panel.
- Added operational `/healthz` checks.
- Fixed Telegram polling cancellation by forwarding the polling AbortSignal to the active HTTP request.
- Prevented default sources and targets from being re-seeded on every restart.
- Preserved existing templates, custom emoji support, source types, commands, price alerts and publishing layout.
