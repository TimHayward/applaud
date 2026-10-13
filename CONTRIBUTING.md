# Contributing to Applaud

Thanks for your interest! This is a small self-hosted tool; the bar for contributions is "keep it working, keep it simple."

## Getting started

```bash
git clone https://github.com/rsteckler/applaud.git
cd applaud
pnpm install
pnpm dev        # Vite dev server on :44470 proxying /api + /media to the Express server on :44471
```

Requires Node.js >= 22 (Node 20 reached end-of-life in April 2026) and pnpm >= 9. `better-sqlite3` ships prebuilt binaries for Node 20–26; other versions may need a local C++ toolchain.

## Repository layout

| Path | What |
| --- | --- |
| `server/src` | Express server: Plaud API client, sync poller, SQLite state, webhooks, routes |
| `web/src` | React + Vite + Tailwind UI |
| `shared/src` | Types and pure helpers shared by both (build this first: `pnpm --filter @applaud/shared build`) |
| `docs/api.md` | HTTP API reference |
| `n8n/` | Importable n8n workflow templates |

## Checks to run before a PR

```bash
pnpm lint        # ESLint (flat config at eslint.config.js)
pnpm -r typecheck
pnpm test        # vitest — server, shared, and web unit tests
pnpm build       # web bundle + server dist must both compile
```

CI runs all four on every PR (`.github/workflows/test.yml`), including coverage thresholds — if your change drops coverage below the ratchet in `vitest.config.ts`, add tests.

Formatting is Prettier (`pnpm format`); note the codebase has not yet been mass-formatted, so avoid reformatting files you aren't otherwise touching.

## Conventions

- TypeScript strict mode everywhere; no `any` outside tests.
- Server: keep route handlers thin — SQL and business logic live in `server/src/sync/state.ts` or a domain module, validated with zod at the route boundary.
- Web: shared formatters in `web/src/lib/format.ts`, shared behavior in `web/src/hooks/`, one component per file in `web/src/components/`.
- Tests sit next to the code (`foo.test.ts`). DB tests use the in-memory fixture in `server/src/test/fixtures/db.ts`.
- User-visible strings: sentence case, no exclamation marks.

## Releases

Maintainers: `scripts/release-version.sh <version>` bumps all package versions, tags, and pushes; the tag triggers the Docker build + GitHub Release via `.github/workflows/release.yml`.
