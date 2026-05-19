# Drop Day Guide

## Topps Drops — Weekdays at 11:00 AM Central

### 10:50 AM — Open Topps in YOUR Chrome browser

1. Go to **https://www.topps.com** in Chrome
2. Wait for the page to fully load (you pass Cloudflare as a human — instant)
3. Click the **Cookie-Editor** extension icon → **Export** → **Copy**

### 10:52 AM — Import cookies to the bot

Save the copied cookies to a file and import:
```bash
# Option A: save to file then import
pbpaste > cookies.json   # (Mac) or just save from clipboard
npx tsx packages/bot/src/main.ts import-cookies topps < cookies.json

# Option B: pipe directly (Mac)
pbpaste | npx tsx packages/bot/src/main.ts import-cookies topps
```

You should see:
```
✅ cf_clearance found (expires: ...)
✅ 35 topps cookies imported to database
```

### 10:55 AM — Start the bot

```bash
export CAPSOLVER_API_KEY="CAP-2B45673487CDA89D07E9C5CE5159BB7C31DE27E0C627F004337E5E76685524FE"
npx tsx packages/bot/src/main.ts start 2
```

The bot now scans with YOUR Cloudflare clearance — no blocks, pure speed.

### 11:00 AM — Drop goes live

Bot detects stock → fast checkout → order placed in ~2 seconds.

### After the drop

```bash
npx tsx packages/bot/src/main.ts logs 2
```

---

## Why This Works (10/10)

Cloudflare blocks automated browsers (Playwright, Camoufox, etc.) but **cannot block valid `cf_clearance` cookies from a real browser session**. By importing your cookies:

- API scan: no CF block → finds product in ~200ms
- Cart add: uses your session → instant
- Fast checkout: pure HTTP → ~2 seconds total
- No browser needed at all during the drop

---

## Updating keywords for a new drop

Edit `config.yaml`:
```yaml
tasks:
  - site: "topps"
    keywords: "+inception, +baseball, +hobby"   # change for each drop
    quantity: 3
```

Reload:
```bash
rm card-bot.db && npx tsx packages/bot/src/main.ts load-config config.yaml
```

---

## Best Buy Drops (random timing)

When you expect a Best Buy drop:
```bash
export CAPSOLVER_API_KEY="CAP-2B45673487CDA89D07E9C5CE5159BB7C31DE27E0C627F004337E5E76685524FE"
npx tsx packages/bot/src/main.ts start 1
```
Ctrl+C to stop when done.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "API blocked (403)" | Import fresh cookies from your browser |
| "cf_clearance" expired | Re-visit topps.com in Chrome, re-export cookies |
| "Cart failed" | Cookies may be stale — re-import from browser |
| Bot found stock but checkout failed | Send logs — I'll tune the fast checkout |
