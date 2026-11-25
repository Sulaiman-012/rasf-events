# CLAUDE.md — Rasf events platform

Instructions for Claude when working on this repository.

## What this is
An internal events/quiz platform for Rasf Investment (Dam Holding Group, Saudi Arabia). Employees scan a QR code and answer questions. LG StanbyME portrait screens, driven by the Nayra (النيرة) signage CMS, display the quiz. Managers run everything from `/admin`.

- Live: https://rasf-events.s-aldweesh.workers.dev (screens: `/tv`, admin: `/admin`)
- Stack: one Cloudflare Worker (TypeScript, no framework) + Cloudflare D1 (SQLite). Free plan only — do not add paid services (R2, Access, KV paid tiers) without the owner's approval.
- UI language: Arabic, RTL. All user-facing text in Arabic. The owner communicates in Gulf Arabic.

## Map
- `src/index.ts` routing + security headers · `src/api.ts` business logic · `src/auth.ts` staff/participant auth · `src/lib.ts` helpers + `ensureSchema` (auto-creates/upgrades tables).
- `public/` vanilla HTML/CSS/JS SPA (`app.js` is the whole front end), `public/_headers` CSP. Screen pages (`/tv`, `/screen/*`) are allowed to be framed (the Nayra CMS embeds them); everything else is `frame-ancestors 'none'`.
- `migrations/*.sql` schema. Production does NOT run `wrangler d1 migrations apply`; `ensureSchema` applies new migrations idempotently, so any new migration must also be wired into `ensureSchema`.
- `tests/e2e.py` Playwright end-to-end suite (55 checks) — run against `npx wrangler dev --local`.
- `HANDOVER.md` full technical handover (Arabic).

## Rules
- Grading happens on the server; never send correct answers to the client before attempts are exhausted.
- Enforce permissions in the API, not only the UI (owner > manager; employees have no account).
- Never use alert/confirm/prompt; escape user text (textContent).
- Before pushing: `npx tsc --noEmit` and the e2e suite must pass. Pushing to `main` deploys to production automatically (GitHub Actions → Cloudflare), so never push untested changes.
- Secrets (`CLOUDFLARE_API_TOKEN`, `SETUP_KEY`, `SESSION_SECRET`) live in GitHub Actions secrets only. Never commit them; `.dev.vars` is git-ignored.

## Local dev
```bash
npm ci
printf 'SETUP_KEY=dev\nSESSION_SECRET=dev-secret-at-least-32-characters-long\n' > .dev.vars
npx wrangler dev --local     # http://localhost:8787 ; first open /setup
python3 tests/e2e.py
```
