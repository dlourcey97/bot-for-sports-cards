# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Card Bot is a TypeScript trading card purchasing bot that auto-buys from Best Buy, Topps, and Dick's Sporting Goods. It uses Playwright for browser automation, Drizzle ORM with SQLite for data persistence, and Pino for logging.

The repository originally contained only a concatenated source dump (`card-bot-source.txt`). The dev environment scaffolds a proper npm workspaces monorepo around it:

- `packages/db` — Drizzle ORM schema + SQLite database (`@workspace/db`)
- `packages/bot` — Bot logic (extracted source) + CLI entry point + stub modules

### Key commands

| Action | Command |
|--------|---------|
| Install deps | `npm install` (from repo root) |
| Type check | `npx tsc --noEmit --project packages/db/tsconfig.json && npx tsc --noEmit --project packages/bot/tsconfig.json` |
| Run tests | `npx tsx packages/bot/src/__tests__/bot.test.ts` |
| CLI status | `npx tsx packages/bot/src/main.ts status` |
| Seed demo data | `npx tsx packages/bot/src/main.ts seed` |
| Dry run | `npx tsx packages/bot/src/main.ts dry-run <taskId>` |
| Start bot | `npx tsx packages/bot/src/main.ts start <taskId>` |
| View logs | `npx tsx packages/bot/src/main.ts logs [taskId]` |

### Non-obvious caveats

- **Playwright Chromium required**: After `npm install`, run `npx playwright install chromium --with-deps` to get the browser binary. Without it, dry-run and start commands will fail.
- **SQLite DB is auto-created**: The `card-bot.db` file is created in the working directory on first run. Delete it to reset state.
- **Original source has relaxed TypeScript**: The bot package uses `strict: false` and `@ts-nocheck` on `toppsBot.ts` because the original source was not written for strict TypeScript. Do not enable strict mode without fixing the original type issues.
- **Stub modules**: `stealthBrowser.ts`, `capSolver.ts`, `dicksBot.ts`, `stockChecker.ts`, and `logger.ts` are placeholder implementations. The real implementations were not included in the original source dump.
- **CapSolver not configured**: CAPTCHA solving requires a `CAPSOLVER_API_KEY` environment variable. Without it, the bot will skip CAPTCHAs and may be blocked by Cloudflare/reCAPTCHA on retailer sites.
- **Dry run is the safest way to test**: Always use `dry-run` instead of `start` to avoid placing real orders.
