# Courtline (Weekend V1)

A lightweight youth sports tournament hub where **email is the integration**. Parents forward tournament confirmations, draw postings, venue moves, rain delays, and league receipts to a kid's dedicated inbox address; an LLM extracts structured fields (`event_name`, `date`, `venue`, `division`, `fee`, `source_league`, `format`, `deadline`, `withdrawal`) and updates one shareable schedule page per kid with automatic alerts when a draw posts, a match time shifts, or a venue moves.

No user accounts. No native app. No scraping USTA or UTR logins.

## V1 Scope

1. **Landing Page (`/`)** — Product overview, live email-to-alert example, and instant zero-account schedule page creation for new kids.
2. **Forward-an-Email Inbox (`/inbox` and `/kid/:slug/inbox`)** — Kid's unique forwarding address, paste/forward composer (structured fields or raw `.eml`), one-click realistic test emails, real webhook endpoint (`POST /api/inbound-email`), and full received-email history with extracted JSON.
3. **Kid Schedule Page (`/kid/:slug`, seeded at `/kid/mia-yang`)** — Unified cross-league schedule, active alerts banner with before → after diffs, league filters, explicit withdrawal handling (counted as a withdrawal, never a played match), expandable source-email trails, and `.ics` calendar export.

## Quick Start

Requires **Node.js 22+** (zero external npm packages — uses built-in `node:sqlite`, `node:http`, and `fetch`).

```bash
npm start
# Runs at http://localhost:3000 (seeded automatically with Mia Yang's 4 real events)
```

Run automated tests:

```bash
npm test
```

## Enabling Live LLM Extraction

By default, Courtline runs with a deterministic local structured parser so you can test forwarding emails immediately with zero API keys. To enable live LLM extraction, set any one of these environment variables before starting the server:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # defaults to claude-3-5-haiku-latest
# or
export OPENAI_API_KEY="sk-..."          # defaults to gpt-4o-mini
# or
export GEMINI_API_KEY="..."             # defaults to gemini-2.5-flash

# Optional model override:
export COURTLINE_LLM_MODEL="gpt-4o-mini"
```

## Connecting Real Forwarded Emails (5-Minute Setup)

Point an inbound email provider (**Postmark Inbound**, **Resend**, **Mailgun Routes**, or **Cloudflare Email Routing** Worker) to:

```text
POST https://your-domain.com/api/inbound-email
```

Courtline accepts Postmark (`From`, `To`, `Subject`, `TextBody`), Mailgun/Resend (`from`, `to`, `subject`, `text` / `body-plain`), raw `.eml` (`raw_eml`), or simple JSON, and automatically routes the email to the kid matching the local-part of the `To` address (for example, `mia-yang@inbox.courtline.app` → `mia-yang`).

## Project Layout

- `server.js` — HTTP server, REST API, inbound email webhook, raw `.eml` parser, static serving
- `src/db.js` — `node:sqlite` schema (`kids`, `events`, `emails`, `alerts`) and queries
- `src/extractor.js` — LLM extraction (Anthropic / OpenAI / Gemini) + deterministic local parser fallback
- `src/matcher.js` — Event matching/merging, field diffing, and automatic alert generation
- `src/seed.js` — Mia Yang's real 4-event seed dataset + sample forwardable emails
- `src/ics.js` — Per-kid `.ics` calendar export (marks withdrawn events `STATUS:CANCELLED`)
- `public/` — Vanilla HTML, CSS, and JS for the Landing Page, Forward Inbox, and Schedule Page
- `tests/core.test.js` — Automated `node:test` coverage
