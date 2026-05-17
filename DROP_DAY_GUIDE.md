# Drop Day Guide

## Topps Drops — Weekdays at 11:00 AM Central

### 10:50 AM — Lock session
```bash
export CAPSOLVER_API_KEY="CAP-2B45673487CDA89D07E9C5CE5159BB7C31DE27E0C627F004337E5E76685524FE"
npx tsx packages/bot/src/main.ts warmup lock topps
```
Wait for "🔒 Session locked!" message.

### 10:55 AM — Start the bot (in a second terminal)
```bash
export CAPSOLVER_API_KEY="CAP-2B45673487CDA89D07E9C5CE5159BB7C31DE27E0C627F004337E5E76685524FE"
npx tsx packages/bot/src/main.ts start 2
```
Bot will scan every 3 seconds. When the drop goes live at 11:00, it executes instantly.

### 11:00 AM — Drop goes live
Bot detects stock → fast checkout fires → order placed in ~2 seconds.

### After the drop
Check your logs:
```bash
npx tsx packages/bot/src/main.ts logs 2
```

## Best Buy Drops — Random timing

### When you know a drop is coming
```bash
export CAPSOLVER_API_KEY="CAP-2B45673487CDA89D07E9C5CE5159BB7C31DE27E0C627F004337E5E76685524FE"
npx tsx packages/bot/src/main.ts start 1
```
Bot polls the cart API every 750ms. Leave it running — it'll catch the restock.

## Updating keywords for a new drop

Edit `config.yaml` — change the keywords to match the drop:
```yaml
tasks:
  - site: "topps"
    keywords: "+bowman, +chrome, +hobby"    # change these
    productUrl: ""                           # leave blank unless you know it
    quantity: 1
```

Then reload:
```bash
rm card-bot.db
npx tsx packages/bot/src/main.ts load-config config.yaml
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "API unreachable (403)" | Run `warmup lock topps` first |
| "CAPSOLVER_API_KEY not set" | Run the `export` command |
| "Cart failed" | Cookies expired — run `warmup lock topps` to refresh |
| "Profile not found" | Run `load-config config.yaml` first |
| Bot found stock but checkout failed | Send me the logs — I'll tune the fast checkout |
