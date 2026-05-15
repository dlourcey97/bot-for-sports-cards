// @ts-nocheck — extracted from card-bot-source.txt; not strict-TS-safe
import type { Page, Browser } from "playwright";
import { launchStealthBrowser, createStealthContext, humanDelay } from "./stealthBrowser";
import { handleAnyCaptcha, solveTurnstile } from "./capSolver";
import type { BotProfile, BotTask, LogFn } from "./dicksBot";

// ── CLOUDFLARE DETECTION ──────────────────────────────────────────────────────

/** Returns true if the current page is a Cloudflare challenge/block page */
async function isCloudflareBlock(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  if (
    title.includes("Attention Required") ||
    title.includes("Just a moment") ||
    title.includes("Checking your browser") ||
    url.includes("cdn-cgi/challenge-platform") ||
    url.includes("challenges.cloudflare.com")
  ) return true;

  // Title can be empty mid-render — also check DOM body content for CF markers
  const hasCfContent = await page.evaluate(() => {
    const body = document.body?.innerText ?? "";
    const html = document.documentElement?.innerHTML ?? "";
    return (
      body.includes("Attention Required") ||
      body.includes("Click to reveal") ||
      body.includes("Verify you are human") ||
      html.includes("cdn-cgi/challenge-platform") ||
      html.includes("challenges.cloudflare.com") ||
      !!document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
      !!document.querySelector(".cf-error-details, #cf-error-details")
    );
  }).catch(() => false);

  return hasCfContent;
}

/**
 * Check for a Cloudflare block on the current page.
 * If detected, attempts to solve via CapSolver Turnstile, then re-navigates to `returnUrl`.
 * Returns true if the block was cleared (or wasn't present), false if it couldn't be solved.
 */
async function handleCloudflareThenGoTo(
  page: Page,
  returnUrl: string,
  log: LogFn,
  proxyUrl?: string
): Promise<boolean> {
  if (!(await isCloudflareBlock(page))) return true;
  await log("warn", `⚠️ Cloudflare challenge detected — attempting to solve with proxy...`);
  try {
    const solved = await solveTurnstile(page, proxyUrl);
    if (solved) {
      await log("info", "Cloudflare challenge solved — re-navigating...");
      await humanDelay(2000, 3000);
      if (page.url() !== returnUrl) {
        await page.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await humanDelay(1500, 2500);
      }
      return !(await isCloudflareBlock(page));
    }
    await log("warn", "⛔ CapSolver could not solve Cloudflare challenge. The proxy IP may be flagged. Try refreshing your Decodo proxy traffic allocation.");
    return false;
  } catch (e) {
    await log("warn", `Cloudflare solve error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ── QUEUE DETECTION ──────────────────────────────────────────────────────────

/** Returns true if the current page is a Queue-it (or similar) waiting room. */
async function isInQueue(page: Page): Promise<boolean> {
  const url = page.url();
  if (
    url.includes("queue-it.net") ||
    url.includes("queueit") ||
    url.includes("waiting-room") ||
    url.includes("waitingroom") ||
    url.includes("queueittoken")
  ) return true;

  // Also check DOM for Queue-it signature elements
  const hasQueueDom = await page.evaluate(() => {
    const ids = ["queueitmain", "MainPart", "divQueuePosition", "waitingroom", "h2QueueNumber"];
    if (ids.some((id) => document.getElementById(id))) return true;
    const text = document.body?.innerText?.toLowerCase() ?? "";
    return (
      text.includes("you are in line") ||
      text.includes("you are in the queue") ||
      text.includes("your position in line") ||
      text.includes("estimated wait") ||
      (text.includes("in line") && text.includes("position"))
    );
  }).catch(() => false);

  return hasQueueDom;
}

/** Read the current queue position / estimated wait from the page, if available. */
async function readQueueInfo(page: Page): Promise<string> {
  return page.evaluate(() => {
    const posEl =
      document.getElementById("divQueuePosition") ??
      document.getElementById("h2QueueNumber") ??
      document.querySelector<HTMLElement>("[class*='queue-position'], [class*='queuePosition'], [id*='position']");

    const waitEl =
      document.getElementById("tdEstimatedWaitTime") ??
      document.querySelector<HTMLElement>("[class*='estimated-wait'], [class*='estimatedWait'], [id*='wait']");

    const pos = posEl?.innerText?.trim();
    const wait = waitEl?.innerText?.trim();

    if (pos && wait) return `Position: ${pos} — Est. wait: ${wait}`;
    if (pos) return `Position in queue: ${pos}`;
    if (wait) return `Estimated wait: ${wait}`;
    return "In queue — position not available";
  }).catch(() => "In queue — could not read position");
}

/**
 * Waits through a Queue-it (or similar) virtual waiting room.
 * Polls every 30 seconds, logs position updates, and resolves once the
 * waiting room releases us back to the store. Times out after maxWaitMs.
 *
 * Returns true if we made it through, false if timed out or aborted.
 */
async function waitThroughQueue(
  page: Page,
  log: LogFn,
  signal: AbortSignal,
  maxWaitMs = 2 * 60 * 60 * 1000 // 2 hours
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let lastLoggedMinute = -1;

  await log("info", "Virtual queue detected — holding browser session open and waiting in line...");

  while (Date.now() < deadline) {
    if (signal.aborted) return false;

    const stillInQueue = await isInQueue(page);
    if (!stillInQueue) {
      await log("success", "Queue released — proceeding to product page!");
      return true;
    }

    // Log position every ~2 minutes to avoid flooding the log
    const minutesWaited = Math.floor((Date.now() - (deadline - maxWaitMs)) / 60000);
    if (minutesWaited !== lastLoggedMinute && minutesWaited % 2 === 0) {
      lastLoggedMinute = minutesWaited;
      const info = await readQueueInfo(page);
      await log("info", `[Queue] ${info} (${minutesWaited}m waited)`);
    }

    // Wait 30 seconds before checking again — but honour abort signal
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  await log("warn", "Queue wait timed out after 2 hours — stopping task");
  return false;
}

// ── POPUP DISMISSAL ──────────────────────────────────────────────────────────

async function dismissPopups(page: Page) {
  try {
    const selectors = [
      '[aria-label="Close"]',
      'button:has-text("No Thanks")',
      'button:has-text("Close")',
      '[data-testid="close-button"]',
      'button:has-text("Not Now")',
      '.modal__close',
      '[class*="close-btn"]',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click();
        await humanDelay(300, 600);
        break;
      }
    }
  } catch {}
}

/**
 * After clicking Add to Cart, Topps may show a "Sign in to purchase" modal.
 * This tries to dismiss it by clicking "Continue as guest" or similar,
 * or closes the modal so the cart drawer can open.
 */
async function handleLoginGate(page: Page, log: LogFn, email?: string, password?: string) {
  try {
    // First: check if there's a login form visible in a modal (Topps often shows this after Add to Cart)
    const loginForm = page.locator('form[action*="/account/login"], input[name="customer[email]"]').first();
    const hasLoginForm = await loginForm.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasLoginForm && email && password) {
      await log("info", "Login modal detected — signing into Topps account...");
      const emailField = page.locator('input[name="customer[email]"], input[type="email"]').first();
      const passwordField = page.locator('input[name="customer[password]"], input[type="password"]').first();
      if (await emailField.isVisible({ timeout: 3000 }).catch(() => false)) {
        await emailField.fill(email);
        await humanDelay(200, 400);
      }
      if (await passwordField.isVisible({ timeout: 2000 }).catch(() => false)) {
        await passwordField.fill(password);
        await humanDelay(200, 400);
        await passwordField.press("Enter");
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await humanDelay(1500, 2500);
      return;
    }

    // Second: look for a "Continue as guest" button
    const guestSelectors = [
      'button:has-text("Continue as guest")',
      'button:has-text("Continue as Guest")',
      'button:has-text("Guest Checkout")',
      'button:has-text("Continue without signing in")',
      'button:has-text("Skip")',
      'a:has-text("Continue as guest")',
      'a:has-text("Guest Checkout")',
    ];
    for (const sel of guestSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await log("info", "Login gate — no credentials, continuing as guest");
        await btn.click();
        await humanDelay(800, 1500);
        return;
      }
    }
  } catch {}
}

// ── TOPPS LOGIN ───────────────────────────────────────────────────────────────

/**
 * Detects if the current page is a Topps/Shopify login wall and, if so,
 * signs in using the profile credentials, then navigates back to returnUrl.
 * Returns true if login succeeded (or wasn't needed), false on failure.
 */
async function loginToToppsIfNeeded(
  page: Page,
  email: string,
  password: string,
  returnUrl: string,
  log: LogFn
): Promise<boolean> {
  try {
    const url = page.url();
    const isLoginPage =
      url.includes("/account/login") ||
      url.includes("/account/sign_in") ||
      url.includes("/login") ||
      !!(await page.locator('form[action*="/account/login"], input[name="customer[email]"]').first().isVisible({ timeout: 2000 }).catch(() => false));

    if (!isLoginPage) return true; // no login wall — all clear

    await log("info", "Login required — signing into Topps account...");

    // Fill email
    const emailField = page.locator(
      'input[name="customer[email]"], input[type="email"][name*="email"], input[id*="email"]'
    ).first();
    if (await emailField.isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailField.click();
      await humanDelay(200, 400);
      await emailField.fill(email);
      await humanDelay(300, 500);
    } else {
      await log("warn", "Login page detected but email field not found — proceeding as guest");
      return false;
    }

    // Fill password
    const passwordField = page.locator(
      'input[name="customer[password]"], input[type="password"]'
    ).first();
    if (await passwordField.isVisible({ timeout: 3000 }).catch(() => false)) {
      await passwordField.click();
      await humanDelay(200, 400);
      await passwordField.fill(password);
      await humanDelay(300, 600);
    }

    // Submit login form
    const submitBtn = page.locator(
      'button[type="submit"]:has-text("Sign in"), button[type="submit"]:has-text("Log in"), button[type="submit"]:has-text("Login"), input[type="submit"]'
    ).first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      // Fallback: submit via keyboard
      await passwordField.press("Enter");
    }

    // Wait for redirect away from login page
    await page.waitForURL((u) => !u.toString().includes("/account/login"), { timeout: 15000 }).catch(() => {});
    await humanDelay(1500, 2500);

    if (page.url().includes("/account/login")) {
      await log("warn", "Login may have failed — still on login page (wrong password or CAPTCHA)");
      return false;
    }

    await log("info", "✅ Logged in to Topps — navigating to product...");
    await page.goto(returnUrl, { waitUntil: "commit", timeout: 30000 });
    await humanDelay(1500, 2500);
    return true;
  } catch (err) {
    await log("warn", `Login attempt error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── SHOPIFY PRODUCT API SCAN ─────────────────────────────────────────────────

/**
 * Queries the Topps Shopify product API directly by keyword.
 * Returns { url, apiReachable } so callers can distinguish:
 *   - apiReachable: true,  url: string  → found an in-stock match
 *   - apiReachable: true,  url: null    → API responded but nothing in stock / no match
 *   - apiReachable: false, url: null    → API blocked or network failure
 */
async function findToppsProductUrl(
  keywords: string,
  proxyUrl?: string | null
): Promise<{ url: string | null; apiReachable: boolean; debugStatus?: number; debugError?: string }> {
  const parts = keywords.split(",").map((k) => k.trim());
  const positive = parts.filter((k) => k.startsWith("+")).map((k) => k.slice(1).trim().toLowerCase());
  const negative = parts.filter((k) => k.startsWith("-")).map((k) => k.slice(1).trim().toLowerCase());
  const searchQuery = (positive.length > 0 ? positive : parts).slice(0, 5).join(" ");
  const encoded = encodeURIComponent(searchQuery);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);

  try {
    let response: Response;
    if (proxyUrl) {
      const { fetch: undiciFetch, ProxyAgent } = await import("undici");
      const dispatcher = new ProxyAgent(proxyUrl);
      response = await (undiciFetch as unknown as (url: string, init?: Record<string, unknown>) => Promise<Response>)(
        `https://www.topps.com/products.json?q=${encoded}&limit=100`,
        { dispatcher, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9" }, signal: ac.signal }
      );
    } else {
      response = await fetch(
        `https://www.topps.com/products.json?q=${encoded}&limit=100`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, signal: ac.signal }
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      return { url: null, apiReachable: false, debugStatus: response.status };
    }

    // Make sure we actually got JSON (CF sometimes returns 200 with HTML)
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return { url: null, apiReachable: false, debugError: `non-JSON response (${contentType})` };
    }

    const data = await response.json() as { products?: Array<{ title: string; handle: string; variants: Array<{ available: boolean }> }> };
    if (!data.products) return { url: null, apiReachable: false };

    for (const product of data.products) {
      const title = product.title.toLowerCase();
      if (positive.length > 0 && !positive.every((k) => title.includes(k))) continue;
      if (negative.some((k) => title.includes(k))) continue;
      if (!product.variants.some((v) => v.available)) continue;
      return { url: `https://www.topps.com/products/${product.handle}`, apiReachable: true };
    }
    // API responded but no match in stock
    return { url: null, apiReachable: true };
  } catch (err) {
    clearTimeout(timer);
    const cause = (err as { cause?: unknown })?.cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    const msg = err instanceof Error ? err.message : String(err);
    return { url: null, apiReachable: false, debugError: causeMsg ? `${msg} — cause: ${causeMsg}` : msg };
  }
}

// ── MAIN BOT ─────────────────────────────────────────────────────────────────

async function runToppsBotImpl(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<boolean> {
  let browser: Browser | null = null;

  try {
    // ── FAST API PRE-SCAN ───────────────────────────────────────────────────
    // Check Topps product API by keyword BEFORE launching browser.
    // Only spin up Playwright when we know something is actually in stock.
    await log("info", `🔎 Scanning Topps API for: "${task.keywords}"`);
    const { url: apiUrl, apiReachable, debugStatus, debugError } = await findToppsProductUrl(task.keywords, profile.proxyUrl);

    let targetUrl: string;
    if (apiUrl) {
      await log("info", `✅ In-stock product found via API — going to checkout: ${apiUrl}`);
      targetUrl = apiUrl;
    } else if (apiReachable) {
      // API reached successfully but nothing matched — product not in stock yet
      return false;
    } else if (task.productUrl && task.productUrl.includes("/products/")) {
      // API was blocked/unreachable — fall back to the configured product URL
      const reason = debugError ?? (debugStatus ? `HTTP ${debugStatus}` : "unknown");
      await log("warn", `Topps API unreachable via proxy (${reason}) — falling back to direct product URL`);
      targetUrl = task.productUrl;
    } else {
      const reason = debugError ?? (debugStatus ? `HTTP ${debugStatus}` : "unknown");
      await log("warn", `Topps API unreachable (${reason}) and no product URL configured — will retry next cycle`);
      return false;
    }

    if (signal.aborted) return false;

    browser = await launchStealthBrowser();
    const context = await createStealthContext(browser, profile.proxyUrl);

    // ── INJECT SAVED SESSION COOKIES ─────────────────────────────────────────
    if (profile.toppsCookies) {
      try {
        const cookies = JSON.parse(profile.toppsCookies);
        if (Array.isArray(cookies) && cookies.length > 0) {
          // Ensure all cookies have the required domain field
          const normalized = cookies.map((c: Record<string, unknown>) => ({
            ...c,
            domain: c.domain || ".topps.com",
            path: c.path || "/",
            sameSite: (c.sameSite as string) || "Lax",
          }));
          await context.addCookies(normalized);
          await log("info", `Loaded ${normalized.length} saved session cookies — bot will appear logged in`);
        }
      } catch {
        await log("warn", "Failed to parse Topps session cookies — proceeding as guest");
      }
    }

    const page = await context.newPage();

    if (signal.aborted) return false;

    await dismissPopups(page);

    // ── NAVIGATE DIRECTLY TO PRODUCT ────────────────────────────────────────
    // targetUrl is already resolved by API pre-scan above — go straight there
    await log("info", `Navigating to product page...`);
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 }).catch(async () => {
      // networkidle can time out on heavy pages — wait for domcontentloaded at minimum
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    });

    // Give the Shopify React frontend time to hydrate (skeleton → real content)
    await humanDelay(4000, 6000);

    // If page still looks empty, try one reload
    const initialTitle = await page.title().catch(() => "");
    if (!initialTitle) {
      await log("info", "Page title empty after wait — reloading once...");
      await page.reload({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      await humanDelay(3000, 5000);
    }

    // ── CLOUDFLARE CHALLENGE (solve before doing anything else) ──────────────
    if (await isCloudflareBlock(page)) {
      await log("warn", "⚠️ Cloudflare challenge detected after navigation — attempting solve...");

      // Try CapSolver first
      const cfCleared = await handleCloudflareThenGoTo(page, targetUrl, log, profile.proxyUrl);

      // Fallback: directly click the "Click to reveal" / "Verify you are human" button
      if (!cfCleared || await isCloudflareBlock(page)) {
        await log("info", "CapSolver couldn't clear CF — trying direct button click...");
        const cfBtn = page.locator(
          'button:has-text("Click to reveal"), button:has-text("Verify you are human"), ' +
          'button:has-text("I am not a robot"), input[type="submit"]'
        ).first();
        if (await cfBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await cfBtn.click();
          await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
          await humanDelay(3000, 5000);
        }
      }

      // If still blocked, skip this cycle and retry
      if (await isCloudflareBlock(page)) {
        await log("warn", "Cloudflare block persists — retrying next cycle");
        return false;
      }
    }

    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

    // ── LOGIN WALL ───────────────────────────────────────────────────────────
    // Topps drops often require a logged-in account. If we land on a login page,
    // sign in using profile credentials and return to the product URL.
    const loggedIn = await loginToToppsIfNeeded(page, profile.email, profile.password, targetUrl, log);
    if (!loggedIn) {
      await log("warn", "Could not log in — attempting to proceed as guest");
    }

    // ── QUEUE WAIT (if applicable) ───────────────────────────────────────────
    if (await isInQueue(page)) {
      await log("info", "Virtual queue detected — waiting in line...");
      const passedQueue = await waitThroughQueue(page, log, signal);
      if (!passedQueue) return false;
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      await humanDelay(2000, 3500);
    }

    await dismissPopups(page);

    if (signal.aborted) return false;

    // ── CLICK "SHOP NOW" IF PRESENT (landing page → product page) ────────────
    // The Topps drop page is a landing/marketing page. The actual buyable product
    // is reached by clicking "Shop Now" which navigates to the real product listing.
    const shopNowBtn = page.locator(
      'a:has-text("Shop Now"), a:has-text("Shop now"), button:has-text("Shop Now"), button:has-text("Shop now")'
    ).first();
    const hasShopNow = await shopNowBtn.isVisible({ timeout: 8000 }).catch(() => false);
    if (hasShopNow) {
      await log("info", "Landing page detected — clicking Shop Now...");
      await shopNowBtn.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      // Wait for the product form to appear on the destination page
      await Promise.race([
        page.waitForSelector('form[action*="/cart/add"], button[name="add"]', { timeout: 12000 }),
        page.waitForSelector('button:has-text("Add to Cart"), button:has-text("Add To Cart")', { timeout: 12000 }),
      ]).catch(() => {});
      await humanDelay(800, 1500);
      await log("info", `Shop Now clicked — now on: ${page.url()}`);
    } else {
      await log("info", "No Shop Now button found — assuming direct product page");
    }

    if (signal.aborted) return false;

    const pageUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    await log("info", `Page loaded: "${pageTitle || "(skeleton)"}" | ${pageUrl}`);
    await page.screenshot({ path: "/tmp/topps-debug.png", fullPage: false }).catch(() => {});

    // ── API-FIRST: fetch product JSON from within the browser (same origin, no CORS) ──
    // This works even when the page is in skeleton/loading state because the browser
    // is already on topps.com — we call Shopify's internal fetch endpoints directly.
    await log("info", "Fetching product data via Shopify JSON API...");

    // Extract the product handle from the current URL or the target URL
    const productHandle = (() => {
      const m = pageUrl.match(/\/products\/([^/?#]+)/);
      return m ? m[1] : null;
    })();

    type ShopifyVariant = { id: number; title: string; available: boolean; price: string };
    type ProductJsonResult = { variantId: string | null; price: number | null; error: string | null; allVariants: Array<{ id: number; title: string; available: boolean }> };

    const productJsonResult: ProductJsonResult = await page.evaluate(async ({ handle, targetUrl }: { handle: string | null; targetUrl: string }) => {
      const urls = [
        handle ? `/products/${handle}.json` : null,
        // Also try fetching the "Shop Now" linked product by scanning anchor hrefs in the DOM
      ].filter(Boolean) as string[];

      // Scan ALL <a href="/products/..."> in the DOM — prioritise hobby/shop-now links first
      const anchors = Array.from(document.querySelectorAll("a[href*='/products/']"));
      const hobbyLinks: string[] = [];
      const otherLinks: string[] = [];
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const text = (a.textContent ?? "").toLowerCase();
        const m = href.match(/\/products\/([^/?#]+)/);
        if (!m) continue;
        const jsonUrl = `/products/${m[1]}.json`;
        if (text.includes("shop") || text.includes("hobby") || text.includes("buy") || text.includes("baseball")) {
          hobbyLinks.push(jsonUrl);
        } else {
          otherLinks.push(jsonUrl);
        }
      }
      urls.push(...hobbyLinks, ...otherLinks);

      // Deduplicate
      const seen = new Set<string>();
      const deduped = urls.filter((u) => { if (seen.has(u)) return false; seen.add(u); return true; });

      for (const url of deduped) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = (await res.json()) as { product?: { variants?: ShopifyVariant[] } };
          const variants: ShopifyVariant[] = data.product?.variants ?? [];
          if (!variants.length) continue;

          // Prefer the hobby variant; fall back to the first available one
          const hobbyVariant = variants.find((v) => v.title.toLowerCase().includes("hobby") && v.available)
            ?? variants.find((v) => v.available)
            ?? variants[0];

          const price = hobbyVariant ? parseFloat(hobbyVariant.price) / 100 : null;
          return {
            variantId: hobbyVariant ? String(hobbyVariant.id) : null,
            price,
            error: null,
            allVariants: variants.map((v) => ({ id: v.id, title: v.title, available: v.available })),
          };
        } catch (e) {
          // continue
        }
      }
      return { variantId: null, price: null, error: "no product JSON reachable", allVariants: [] };
    }, { handle: productHandle, targetUrl }).catch(() => ({ variantId: null, price: null, error: "evaluate failed", allVariants: [] }));

    await log("info", `Product JSON result: variantId=${productJsonResult.variantId} price=${productJsonResult.price} variants=${JSON.stringify(productJsonResult.allVariants)}`);

    if (!productJsonResult.variantId) {
      await log("warn", `Could not get variant via API (${productJsonResult.error}) — item not available yet`);
      return false;
    }

    const variantId = productJsonResult.variantId;

    // ── PRICE CHECK ───────────────────────────────────────────────────────────
    if (task.maxPrice != null && productJsonResult.price != null) {
      const price = productJsonResult.price;
      await log("info", `Product price: $${price.toFixed(2)} | Max allowed: $${task.maxPrice.toFixed(2)}`);
      if (price > task.maxPrice) {
        await log("warn", `Skipping — price $${price.toFixed(2)} exceeds your $${task.maxPrice.toFixed(2)} cap`);
        return false;
      }
    }

    await log("success", `Hobby Box found! Variant ${variantId} — adding to cart via API...`);

    if (signal.aborted) return false;

    // ── ADD TO CART + GET CHECKOUT URL (pure Shopify API, no UI needed) ───────
    const apiAddAndGetCheckout = async (vid: string): Promise<string | null> => {
      return page.evaluate(
        async ({ vid, qty }: { vid: string; qty: number }) => {
          try {
            await fetch("/cart/clear.js", { method: "POST" });
            const addRes = await fetch("/cart/add.js", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: parseInt(vid, 10), quantity: qty }),
            });
            if (!addRes.ok) {
              const err = await addRes.text().catch(() => "");
              return `ERROR:${addRes.status}:${err.slice(0, 80)}`;
            }
            const cartRes = await fetch("/cart.json");
            const cartData = (await cartRes.json()) as Record<string, unknown>;
            return (cartData.checkout_url as string) ?? "/checkout";
          } catch (e) {
            return null;
          }
        },
        { vid, qty: task.quantity }
      );
    };

    const getCheckoutUrlFromCart = async (): Promise<string | null> => {
      return page.evaluate(async () => {
        try {
          const res = await fetch("/cart.json");
          const data = (await res.json()) as Record<string, unknown>;
          const items = data.items as Array<Record<string, unknown>> | undefined;
          if (!items || items.length === 0) return null;
          return (data.checkout_url as string) ?? "/checkout";
        } catch { return null; }
      }).catch(() => null);
    };

    let checkoutUrl: string | null = null;

    const apiResult = await apiAddAndGetCheckout(variantId);
    if (apiResult && !apiResult.startsWith("ERROR:")) {
      checkoutUrl = apiResult;
      await log("success", `Cart API succeeded — checkout: ${checkoutUrl}`);
    } else {
      await log("warn", `Cart API response: ${apiResult} — trying login then retry`);
      // Try signing in, then retry add-to-cart
      await handleLoginGate(page, log, profile.email, profile.password);
      await humanDelay(1000, 2000);
      const retryResult = await apiAddAndGetCheckout(variantId);
      if (retryResult && !retryResult.startsWith("ERROR:")) {
        checkoutUrl = retryResult;
        await log("success", `Cart API succeeded after login — checkout: ${checkoutUrl}`);
      } else {
        await log("warn", `Cart API still failing (${retryResult}) — using /checkout directly`);
        checkoutUrl = "/checkout";
      }
    }

    // Navigate directly to the checkout URL using a JS-triggered navigation.
    // This is more natural to Cloudflare than Playwright's programmatic goto().
    const fullCheckoutUrl = checkoutUrl.startsWith("http")
      ? checkoutUrl
      : `https://www.topps.com${checkoutUrl}`;
    await log("info", `Going to checkout: ${fullCheckoutUrl}`);
    // Use JS navigation to mimic a real user click — CF treats this differently than automated goto
    await page.evaluate((url) => { window.location.assign(url); }, fullCheckoutUrl);
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await humanDelay(1000, 2000);

    // ── Cloudflare check immediately after entering checkout ──────────────────
    // Use page.url() so we re-navigate to the actual checkout URL (e.g. /checkouts/cn/...)
    const cfClearedAtCheckout = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
    if (!cfClearedAtCheckout) return false;

    // Queue can appear at checkout too during high-demand drops
    if (await isInQueue(page)) {
      await log("info", "Queue triggered at checkout — waiting...");
      const passed = await waitThroughQueue(page, log, signal);
      if (!passed) return false;
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      await humanDelay(2000, 3000);
    }

    if (signal.aborted) return false;

    // ── Helper: click a button and wait for the page to advance ──────────────
    const clickAndAdvance = async (selector: string, label: string): Promise<boolean> => {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 6000 }).catch(() => false);
      if (!visible) { await log("info", `${label}: button not found — skipping`); return false; }
      const urlBefore = page.url();
      await btn.click();
      // Wait up to 4s for URL to change OR new content to appear
      await Promise.race([
        page.waitForURL((u) => u.toString() !== urlBefore, { timeout: 4000 }).catch(() => {}),
        humanDelay(2500, 3500),
      ]);
      await log("info", `${label}: clicked → now on ${page.url()}`);
      return true;
    };

    // ── CONTACT INFO ─────────────────────────────────────────────────────────
    await log("info", `Entering contact info for ${profile.email}...`);
    await log("info", `[Checkout step] URL: ${page.url()}`);
    const emailInput = page.locator(
      'input[type="email"], input[name="email"], input[id*="email"], input[autocomplete="email"]'
    ).first();
    if (await emailInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await emailInput.click();
      await humanDelay(200, 400);
      await emailInput.fill(profile.email);
      await humanDelay(300, 600);
    }

    // ── SHIPPING ADDRESS ─────────────────────────────────────────────────────
    await log("info", "Filling shipping address...");
    const fields: Array<[string, string]> = [
      ['input[name="firstName"], input[autocomplete="given-name"]', profile.firstName],
      ['input[name="lastName"], input[autocomplete="family-name"]', profile.lastName],
      ['input[name="address1"], input[autocomplete="address-line1"]', profile.address1],
      ...(profile.address2 ? [['input[name="address2"], input[autocomplete="address-line2"]', profile.address2] as [string, string]] : []),
      ['input[name="city"], input[autocomplete="address-level2"]', profile.city],
      ['input[name="zip"], input[autocomplete="postal-code"]', profile.zip],
      ['input[name="phone"], input[type="tel"]', profile.phone],
    ];
    for (const [selector, value] of fields) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.fill(value);
        await humanDelay(150, 350);
      }
    }

    const stateSelect = page.locator('select[name="zone"], select[name="state"], select[id*="state"]').first();
    if (await stateSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await stateSelect.selectOption({ value: profile.state });
      await humanDelay(200, 400);
    }

    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

    // Click "Continue to shipping" — advances from address → shipping method
    await clickAndAdvance(
      'button:has-text("Continue to shipping"), button[data-testid="step-footer-continue-btn"], button:has-text("Continue to delivery"), button[data-testid*="continue"]',
      "Continue to shipping"
    );

    if (signal.aborted) return false;

    // ── SHIPPING METHOD ──────────────────────────────────────────────────────
    await log("info", `Selecting shipping method — URL: ${page.url()}`);
    await humanDelay(1000, 2000);
    // Pick the first/cheapest shipping option if not already selected
    const shippingOption = page.locator('input[type="radio"][name*="shipping"], input[type="radio"][name*="delivery"]').first();
    if (await shippingOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await shippingOption.check().catch(() => {});
      await humanDelay(400, 800);
    }

    // Click "Continue to payment" — advances from shipping method → payment
    await clickAndAdvance(
      'button:has-text("Continue to payment"), button[data-testid="step-footer-continue-btn"]',
      "Continue to payment"
    );

    if (signal.aborted) return false;

    // ── Cloudflare check before payment ──────────────────────────────────────
    const cfClearedBeforePayment = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
    if (!cfClearedBeforePayment) return false;
    await log("info", `[Payment step] URL: ${page.url()}`);

    // ── PAYMENT ──────────────────────────────────────────────────────────────
    await log("info", `Entering payment: **** **** **** ${profile.cardNumber.slice(-4)}`);
    await humanDelay(1500, 2500);

    // Diagnostic: log all iframes on the checkout page so we can debug selectors
    const iframeNames = await page.evaluate(() =>
      [...document.querySelectorAll("iframe")].map(f => `id=${f.id} name=${f.name} src=${f.src.substring(0, 60)}`)
    ).catch(() => []);
    if (iframeNames.length) await log("info", `[Payment debug] iframes: ${iframeNames.join(" | ")}`);

    let paymentFilled = false;

    // ── Strategy 1: Shopify new checkout — one iframe PER field ──────────────
    // e.g. iframe[name="card-fields-number"], iframe[name="card-fields-expiry"], etc.
    const numberFrameEl = await page.$('iframe[name*="number"][name*="card"], iframe[id*="card-fields-number"]');
    if (numberFrameEl) {
      await log("info", "Using Shopify split-iframe payment fields");
      const numberFrame   = page.frameLocator('iframe[name*="number"][name*="card"], iframe[id*="card-fields-number"]').first();
      const expiryFrame   = page.frameLocator('iframe[name*="expiry"], iframe[id*="card-fields-expiry"]').first();
      const cvvFrame      = page.frameLocator('iframe[name*="verification"], iframe[name*="cvv"], iframe[id*="card-fields-verification"]').first();
      const nameFrame     = page.frameLocator('iframe[name*="name"][name*="card"], iframe[id*="card-fields-name"]').first();

      const numberInput = numberFrame.locator('input').first();
      if (await numberInput.isVisible({ timeout: 6000 }).catch(() => false)) {
        await numberInput.fill(profile.cardNumber.replace(/\s/g, ""));
        await humanDelay(300, 500);
      }
      const expiryInput = expiryFrame.locator('input').first();
      if (await expiryInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await expiryInput.fill(profile.cardExpiry);
        await humanDelay(300, 500);
      }
      const cvvInput = cvvFrame.locator('input').first();
      if (await cvvInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await cvvInput.fill(profile.cardCvv);
        await humanDelay(200, 400);
      }
      const nameInput = nameFrame.locator('input').first();
      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill(profile.cardName);
        await humanDelay(200, 400);
      }
      paymentFilled = true;
    }

    // ── Strategy 2: Shopify classic checkout — single combined iframe ─────────
    if (!paymentFilled) {
      const singleFrame = page.frameLocator('iframe[src*="pay.shopify"], iframe[name="card-fields"]').first();
      const singleNumber = singleFrame.locator('input[name="number"], input[placeholder*="Card number"]').first();
      if (await singleNumber.isVisible({ timeout: 4000 }).catch(() => false)) {
        await log("info", "Using Shopify classic combined payment iframe");
        await singleNumber.fill(profile.cardNumber.replace(/\s/g, ""));
        await humanDelay(300, 600);
        await singleFrame.locator('input[name="expiry"], input[placeholder*="MM"]').first().fill(profile.cardExpiry);
        await humanDelay(300, 500);
        await singleFrame.locator('input[name="verification_value"], input[placeholder*="CVV"], input[placeholder*="Security"]').first().fill(profile.cardCvv);
        await humanDelay(200, 400);
        const nameField = singleFrame.locator('input[name="name"], input[placeholder*="Name on card"]').first();
        if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
          await nameField.fill(profile.cardName);
        }
        paymentFilled = true;
      }
    }

    // ── Strategy 3: Direct inputs on page (non-iframe payment) ───────────────
    if (!paymentFilled) {
      const directNumber = page.locator(
        'input[autocomplete="cc-number"], input[name*="cardNumber"], input[placeholder*="Card number"]'
      ).first();
      if (await directNumber.isVisible({ timeout: 4000 }).catch(() => false)) {
        await log("info", "Using direct (non-iframe) payment fields");
        await directNumber.fill(profile.cardNumber.replace(/\s/g, ""));
        await humanDelay(300, 600);
        await page.locator('input[autocomplete="cc-exp"], input[placeholder*="MM"]').first().fill(profile.cardExpiry);
        await humanDelay(300, 500);
        await page.locator('input[autocomplete="cc-csc"], input[placeholder*="CVV"], input[placeholder*="Security"]').first().fill(profile.cardCvv);
        await humanDelay(200, 400);
        paymentFilled = true;
      }
    }

    if (!paymentFilled) {
      // May have a saved payment method already selected — log for visibility but don't bail
      await log("info", "No new card fields found — likely using saved payment method, proceeding to Place Order...");
    }

    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

    if (signal.aborted) return false;

    // ── PLACE ORDER ──────────────────────────────────────────────────────────
    await log("info", "Reviewing order and placing...");

    // ── Cloudflare check before placing order ─────────────────────────────────
    const cfClearedBeforeOrder = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
    if (!cfClearedBeforeOrder) return false;

    // Give Shopify extra time to validate the payment section before revealing the button
    await humanDelay(2500, 4000);
    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

    // Log page state before looking for Pay Now button
    const prePayTitle = await page.title().catch(() => "");
    const prePayUrl = page.url();
    await log("info", `[Place Order step] URL: ${prePayUrl} | Title: ${prePayTitle}`);

    // Shopify checkout Pay Now button — many variants across Shopify versions
    const PAY_BTN_SELECTORS = [
      // Shopify new checkout (2023+)
      'button[data-testid="Checkout-Pay-button"]',
      'button[data-testid="pay-now"]',
      'button[data-testid="checkout-pay-button"]',
      // ID-based
      '#checkout-pay-button',
      'button[id*="pay-now"]',
      'button[id*="pay_now"]',
      // Aria
      'button[aria-label*="Pay now" i]',
      'button[aria-label*="Pay Now" i]',
      'button[aria-label*="Complete order" i]',
      // Text-based
      'button:has-text("Pay now")',
      'button:has-text("Pay Now")',
      'button:has-text("Complete order")',
      'button:has-text("Complete Order")',
      'button:has-text("Place order")',
      'button:has-text("Place Order")',
      'button:has-text("Submit order")',
      'button:has-text("Confirm order")',
      // Class-based
      'button.step__footer__continue-btn',
      // Type+attr
      'button[type="submit"][class*="pay"]',
      'button[type="submit"][id*="pay"]',
      'form[data-payment-form] button[type="submit"]',
      // Last resort: any visible submit button on checkout pages
      '.section--payment-method button[type="submit"]',
      '[data-checkout-payment-submit] button',
    ].join(", ");

    const placeOrderBtn = page.locator(PAY_BTN_SELECTORS).first();

    // Try harder — wait up to 15s since Shopify can be slow after entering payment
    const btnVisible = await placeOrderBtn.isVisible({ timeout: 15000 }).catch(() => false);

    if (btnVisible) {
      if (task.dryRun) {
        await log("success", "✓ DRY RUN COMPLETE — Pay Now button found and all steps validated. No order was placed.");
        return true;
      }
      await log("info", `Clicking Pay Now / Place Order button...`);
      await placeOrderBtn.click();
      await humanDelay(5000, 8000);
      const successIndicator = page.locator(
        'h2:has-text("Thank you"), h1:has-text("Thank you"), [class*="confirmation"], [class*="thank-you"], text=/order.*confirm/i'
      ).first();
      if (await successIndicator.isVisible({ timeout: 12000 }).catch(() => false)) {
        await log("success", "🎉 Order placed successfully on Topps!");
        return true;
      } else {
        // Button was clicked — can't confirm visually but order was likely submitted
        await log("warn", "Checkout submitted — check your Topps account to verify the order");
        return true;
      }
    } else {
      // Dump page title + URL so we can see where the bot actually ended up
      const title = await page.title().catch(() => "unknown");
      const url = page.url();
      if (task.dryRun) {
        await log("error", `✗ DRY RUN FAILED — Pay Now button not found on "${title}" (${url})`);
      } else {
        await log("error", `Could not find Pay Now button — page: "${title}" (${url})`);
      }
      return false;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `Bot error: ${msg.slice(0, 200)}`);
    return false;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Public-facing wrapper — returns BotResult for quantity tracking */
export async function runToppsBot(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<import("./dicksBot").BotResult> {
  const success = await runToppsBotImpl(task, profile, log, signal);
  return { success, qtyPurchased: success ? task.quantity : 0 };
}
