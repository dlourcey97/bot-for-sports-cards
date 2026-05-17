// @ts-nocheck — extracted from card-bot-source.txt; not strict-TS-safe
import type { Page, Browser, BrowserContext } from "playwright";
import { launchStealthBrowser, createStealthContext, humanDelay, getWarmSession, closeWarmSession } from "./stealthBrowser";
import { handleAnyCaptcha, solveTurnstile } from "./capSolver";
import { shopifyFastCheckout } from "./shopifyFastCheckout";
import type { BotProfile, BotTask, LogFn } from "./dicksBot";

// ── SPEED CONFIG ─────────────────────────────────────────────────────────────
// Drop mode: minimize all delays for maximum speed during live drops
const FAST_DELAY = (min: number, max: number) => humanDelay(Math.floor(min * 0.3), Math.floor(max * 0.3));
const CART_RETRY_COUNT = 4;
const CART_RETRY_DELAY_MS = 250;

// ── CLOUDFLARE DETECTION ──────────────────────────────────────────────────────

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

async function handleCloudflareThenGoTo(
  page: Page,
  returnUrl: string,
  log: LogFn,
  proxyUrl?: string
): Promise<boolean> {
  if (!(await isCloudflareBlock(page))) return true;
  await log("warn", `⚠️ Cloudflare challenge detected — solving...`);
  try {
    const solved = await solveTurnstile(page, proxyUrl);
    if (solved) {
      await log("info", "Cloudflare solved — continuing...");
      await FAST_DELAY(500, 1000);
      if (page.url() !== returnUrl) {
        await page.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await FAST_DELAY(500, 1000);
      }
      return !(await isCloudflareBlock(page));
    }

    // Fallback: click the challenge button directly
    const cfBtn = page.locator(
      'button:has-text("Click to reveal"), button:has-text("Verify you are human"), ' +
      'button:has-text("I am not a robot"), input[type="submit"]'
    ).first();
    if (await cfBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cfBtn.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await FAST_DELAY(1000, 2000);
      if (!(await isCloudflareBlock(page))) return true;
    }

    await log("warn", "⛔ Cloudflare block persists — will retry next cycle");
    return false;
  } catch (e) {
    await log("warn", `Cloudflare solve error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ── QUEUE DETECTION ──────────────────────────────────────────────────────────

async function isInQueue(page: Page): Promise<boolean> {
  const url = page.url();
  if (
    url.includes("queue-it.net") ||
    url.includes("queueit") ||
    url.includes("waiting-room") ||
    url.includes("waitingroom") ||
    url.includes("queueittoken")
  ) return true;

  return page.evaluate(() => {
    const ids = ["queueitmain", "MainPart", "divQueuePosition", "waitingroom", "h2QueueNumber"];
    if (ids.some((id) => document.getElementById(id))) return true;
    const text = document.body?.innerText?.toLowerCase() ?? "";
    return (
      text.includes("you are in line") ||
      text.includes("you are in the queue") ||
      text.includes("your position in line") ||
      text.includes("estimated wait")
    );
  }).catch(() => false);
}

async function waitThroughQueue(page: Page, log: LogFn, signal: AbortSignal): Promise<boolean> {
  let waited = 0;
  const MAX_QUEUE_WAIT = 300_000; // 5 min max
  while (waited < MAX_QUEUE_WAIT && !signal.aborted) {
    if (!(await isInQueue(page))) return true;
    const info = await page.evaluate(() => {
      const el = document.getElementById("divQueuePosition") ?? document.querySelector("[class*='queue-position']");
      return el?.innerText?.trim() ?? "waiting...";
    }).catch(() => "waiting...");
    if (waited % 15000 < 5000) await log("info", `Queue: ${info} (${Math.floor(waited / 1000)}s)`);
    await new Promise(r => setTimeout(r, 5000));
    waited += 5000;
  }
  return !(await isInQueue(page));
}

// ── SHOPIFY PRODUCT API — returns variant ID + handle (no browser needed) ────

interface ProductScanResult {
  variantId: string | null;
  handle: string | null;
  price: number | null;
  productUrl: string | null;
  apiReachable: boolean;
  debugStatus?: number;
  debugError?: string;
}

function parseKeywords(keywords: string) {
  const parts = keywords.split(",").map((k) => k.trim());
  const positive = parts.filter((k) => k.startsWith("+")).map((k) => k.slice(1).trim().toLowerCase());
  const negative = parts.filter((k) => k.startsWith("-")).map((k) => k.slice(1).trim().toLowerCase());
  const searchQuery = (positive.length > 0 ? positive : parts).slice(0, 5).join(" ");
  return { positive, negative, searchQuery };
}

type Variant = { id: number; title: string; available: boolean; price: string };

function matchProduct(
  products: Array<{ title: string; handle: string; variants: Variant[] }>,
  positive: string[],
  negative: string[]
): ProductScanResult {
  for (const product of products) {
    const title = product.title.toLowerCase();
    if (positive.length > 0 && !positive.every((k) => title.includes(k))) continue;
    if (negative.some((k) => title.includes(k))) continue;
    if (!product.variants.some((v) => v.available)) continue;

    const variant = product.variants.find((v) => v.title.toLowerCase().includes("hobby") && v.available)
      ?? product.variants.find((v) => v.available)
      ?? product.variants[0];

    return {
      variantId: variant ? String(variant.id) : null,
      handle: product.handle,
      price: variant ? parseFloat(variant.price) / 100 : null,
      productUrl: `https://www.topps.com/products/${product.handle}`,
      apiReachable: true,
    };
  }
  return { variantId: null, handle: null, price: null, productUrl: null, apiReachable: true };
}

// Keep-alive HTTP agent — reuses TCP+TLS connections across requests
let _keepAliveAgent: InstanceType<typeof import("undici").Agent> | null = null;
async function getKeepAliveAgent() {
  if (!_keepAliveAgent) {
    const { Agent } = await import("undici");
    _keepAliveAgent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 4 });
  }
  return _keepAliveAgent;
}

async function scanToppsApi(
  keywords: string,
  proxyUrl?: string | null,
  cookiesJson?: string | null,
): Promise<ProductScanResult> {
  const { positive, negative, searchQuery } = parseKeywords(keywords);
  const encoded = encodeURIComponent(searchQuery);
  const url = `https://www.topps.com/products.json?q=${encoded}&limit=100`;

  // Build cookie header from saved session cookies to bypass Cloudflare
  let cookieHeader = "";
  if (cookiesJson) {
    try {
      const cookies = JSON.parse(cookiesJson);
      if (Array.isArray(cookies)) {
        cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
      }
    } catch {}
  }

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.topps.com/",
    "Origin": "https://www.topps.com",
  };
  if (cookieHeader) headers["Cookie"] = cookieHeader;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);

  try {
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    const agent = proxyUrl ? new ProxyAgent(proxyUrl) : await getKeepAliveAgent();

    const response = await (undiciFetch as any)(url, {
      dispatcher: agent,
      headers,
      signal: ac.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return { variantId: null, handle: null, price: null, productUrl: null, apiReachable: false, debugStatus: response.status };

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return { variantId: null, handle: null, price: null, productUrl: null, apiReachable: false, debugError: `non-JSON (${contentType})` };

    const data = await response.json() as { products?: Array<{ title: string; handle: string; variants: Variant[] }> };
    if (!data.products) return { variantId: null, handle: null, price: null, productUrl: null, apiReachable: false };

    return matchProduct(data.products, positive, negative);
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { variantId: null, handle: null, price: null, productUrl: null, apiReachable: false, debugError: msg };
  }
}

// ── CART API with retry ──────────────────────────────────────────────────────

async function addToCartWithRetry(
  page: Page,
  variantId: string,
  quantity: number,
  log: LogFn
): Promise<{ checkoutUrl: string | null; success: boolean }> {
  for (let attempt = 1; attempt <= CART_RETRY_COUNT; attempt++) {
    const result = await page.evaluate(
      async ({ vid, qty }: { vid: string; qty: number }) => {
        try {
          const addRes = await fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: parseInt(vid, 10), quantity: qty }),
          });
          if (!addRes.ok) {
            const err = await addRes.text().catch(() => "");
            return { ok: false, status: addRes.status, error: err.slice(0, 120) };
          }
          const cartRes = await fetch("/cart.json");
          const cart = await cartRes.json() as Record<string, unknown>;
          const items = cart.items as unknown[];
          if (!items || items.length === 0) return { ok: false, status: 200, error: "cart empty after add" };
          return { ok: true, checkoutUrl: (cart.checkout_url as string) ?? "/checkout" };
        } catch (e) {
          return { ok: false, status: 0, error: String(e) };
        }
      },
      { vid: variantId, qty: quantity }
    ).catch(() => ({ ok: false, status: 0, error: "evaluate crashed" }));

    if (result.ok) {
      return { checkoutUrl: result.checkoutUrl ?? "/checkout", success: true };
    }

    const status = (result as any).status ?? 0;
    const error = (result as any).error ?? "";

    if (status === 429 || status === 503 || status === 520 || status === 522) {
      await log("warn", `Cart add attempt ${attempt}/${CART_RETRY_COUNT}: HTTP ${status} — retrying in ${CART_RETRY_DELAY_MS}ms...`);
      await new Promise(r => setTimeout(r, CART_RETRY_DELAY_MS * attempt));
      continue;
    }

    await log("warn", `Cart add attempt ${attempt}: HTTP ${status} — ${error}`);
    if (attempt < CART_RETRY_COUNT) {
      await new Promise(r => setTimeout(r, CART_RETRY_DELAY_MS));
    }
  }

  return { checkoutUrl: null, success: false };
}

// ── LOGIN ────────────────────────────────────────────────────────────────────

async function loginIfNeeded(
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

    if (!isLoginPage) return true;

    await log("info", "Login required — signing in...");

    const emailField = page.locator('input[name="customer[email]"], input[type="email"]').first();
    if (await emailField.isVisible({ timeout: 4000 }).catch(() => false)) {
      await emailField.fill(email);
      await FAST_DELAY(100, 200);
    } else {
      return false;
    }

    const passwordField = page.locator('input[name="customer[password]"], input[type="password"]').first();
    if (await passwordField.isVisible({ timeout: 3000 }).catch(() => false)) {
      await passwordField.fill(password);
      await FAST_DELAY(100, 200);
    }

    // Solve CAPTCHA BEFORE submitting the login form
    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));

    const submitBtn = page.locator(
      'button[type="submit"]:has-text("Sign in"), button[type="submit"]:has-text("Log in"), button[type="submit"]:has-text("Login"), input[type="submit"]'
    ).first();
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await passwordField.press("Enter");
    }

    await page.waitForURL((u) => !u.toString().includes("/account/login"), { timeout: 15000 }).catch(() => {});
    await FAST_DELAY(500, 1000);

    if (page.url().includes("/account/login")) {
      await log("warn", "Login failed — still on login page");
      return false;
    }

    await log("info", "✅ Logged in — redirecting to product...");
    await page.goto(returnUrl, { waitUntil: "commit", timeout: 20000 });
    await FAST_DELAY(500, 1000);
    return true;
  } catch (err) {
    await log("warn", `Login error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── CHECKOUT FLOW ────────────────────────────────────────────────────────────

async function fillCheckout(
  page: Page,
  profile: BotProfile,
  task: BotTask,
  log: LogFn,
  signal: AbortSignal
): Promise<boolean> {

  // ── CONTACT INFO ─────────────────────────────────────────────────────────
  await log("info", `Filling checkout for ${profile.email}...`);
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id*="email"], input[autocomplete="email"]').first();
  if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
    await emailInput.fill(profile.email);
    await FAST_DELAY(100, 200);
  }

  // ── SHIPPING ADDRESS ───────────────────────────────────────────────────
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
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      await el.fill(value);
      await FAST_DELAY(50, 100);
    }
  }

  const stateSelect = page.locator('select[name="zone"], select[name="state"], select[id*="state"]').first();
  if (await stateSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
    await stateSelect.selectOption({ value: profile.state });
    await FAST_DELAY(100, 200);
  }

  await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

  // Continue to shipping
  const clickAndAdvance = async (selector: string, label: string): Promise<boolean> => {
    const btn = page.locator(selector).first();
    if (!(await btn.isVisible({ timeout: 4000 }).catch(() => false))) return false;
    const urlBefore = page.url();
    await btn.click();
    await Promise.race([
      page.waitForURL((u) => u.toString() !== urlBefore, { timeout: 4000 }).catch(() => {}),
      FAST_DELAY(1000, 1500),
    ]);
    return true;
  };

  await clickAndAdvance(
    'button:has-text("Continue to shipping"), button[data-testid="step-footer-continue-btn"], button:has-text("Continue to delivery"), button[data-testid*="continue"]',
    "Continue to shipping"
  );

  if (signal.aborted) return false;

  // ── SHIPPING METHOD ────────────────────────────────────────────────────
  await FAST_DELAY(500, 1000);
  const shippingOption = page.locator('input[type="radio"][name*="shipping"], input[type="radio"][name*="delivery"]').first();
  if (await shippingOption.isVisible({ timeout: 2000 }).catch(() => false)) {
    await shippingOption.check().catch(() => {});
    await FAST_DELAY(200, 400);
  }

  await clickAndAdvance(
    'button:has-text("Continue to payment"), button[data-testid="step-footer-continue-btn"]',
    "Continue to payment"
  );

  if (signal.aborted) return false;

  const cfOk = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
  if (!cfOk) return false;

  // ── PAYMENT ────────────────────────────────────────────────────────────
  await log("info", `Entering payment: **** ${profile.cardNumber.slice(-4)}`);
  await FAST_DELAY(500, 1000);

  let paymentFilled = false;

  // Strategy 1: Split iframes (Shopify new checkout)
  const numberFrameEl = await page.waitForSelector(
    'iframe[name*="number"][name*="card"], iframe[id*="card-fields-number"]',
    { timeout: 8000 }
  ).catch(() => null);

  if (numberFrameEl) {
    const numberFrame = page.frameLocator('iframe[name*="number"][name*="card"], iframe[id*="card-fields-number"]').first();
    const expiryFrame = page.frameLocator('iframe[name*="expiry"], iframe[id*="card-fields-expiry"]').first();
    const cvvFrame = page.frameLocator('iframe[name*="verification"], iframe[name*="cvv"], iframe[id*="card-fields-verification"]').first();
    const nameFrame = page.frameLocator('iframe[name*="name"][name*="card"], iframe[id*="card-fields-name"]').first();

    const fillFrame = async (frame: ReturnType<Page["frameLocator"]>, value: string, timeout = 4000) => {
      const input = frame.locator("input").first();
      if (await input.isVisible({ timeout }).catch(() => false)) {
        await input.fill(value);
        await FAST_DELAY(100, 200);
      }
    };

    await fillFrame(numberFrame, profile.cardNumber.replace(/\s/g, ""), 6000);
    await fillFrame(expiryFrame, profile.cardExpiry);
    await fillFrame(cvvFrame, profile.cardCvv);
    await fillFrame(nameFrame, profile.cardName);
    paymentFilled = true;
  }

  // Strategy 2: Single iframe (Shopify classic)
  if (!paymentFilled) {
    const singleFrame = page.frameLocator('iframe[src*="pay.shopify"], iframe[name="card-fields"]').first();
    const singleNumber = singleFrame.locator('input[name="number"], input[placeholder*="Card number"]').first();
    if (await singleNumber.isVisible({ timeout: 4000 }).catch(() => false)) {
      await singleNumber.fill(profile.cardNumber.replace(/\s/g, ""));
      await FAST_DELAY(100, 200);
      await singleFrame.locator('input[name="expiry"], input[placeholder*="MM"]').first().fill(profile.cardExpiry);
      await FAST_DELAY(100, 200);
      await singleFrame.locator('input[name="verification_value"], input[placeholder*="CVV"], input[placeholder*="Security"]').first().fill(profile.cardCvv);
      await FAST_DELAY(100, 200);
      const nameField = singleFrame.locator('input[name="name"], input[placeholder*="Name on card"]').first();
      if (await nameField.isVisible({ timeout: 1500 }).catch(() => false)) await nameField.fill(profile.cardName);
      paymentFilled = true;
    }
  }

  // Strategy 3: Direct inputs
  if (!paymentFilled) {
    const directNumber = page.locator('input[autocomplete="cc-number"], input[name*="cardNumber"], input[placeholder*="Card number"]').first();
    if (await directNumber.isVisible({ timeout: 4000 }).catch(() => false)) {
      await directNumber.fill(profile.cardNumber.replace(/\s/g, ""));
      await FAST_DELAY(100, 200);
      await page.locator('input[autocomplete="cc-exp"], input[placeholder*="MM"]').first().fill(profile.cardExpiry);
      await page.locator('input[autocomplete="cc-csc"], input[placeholder*="CVV"]').first().fill(profile.cardCvv);
      paymentFilled = true;
    }
  }

  if (!paymentFilled) {
    await log("info", "No card fields — may have saved payment method");
  }

  await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

  if (signal.aborted) return false;

  // ── PLACE ORDER ────────────────────────────────────────────────────────
  const cfOk2 = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
  if (!cfOk2) return false;

  await FAST_DELAY(500, 1000);
  await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`), profile.proxyUrl);

  const PAY_BTN_SELECTORS = [
    'button[data-testid="Checkout-Pay-button"]',
    'button[data-testid="pay-now"]',
    'button[data-testid="checkout-pay-button"]',
    '#checkout-pay-button',
    'button[aria-label*="Pay now" i]',
    'button[aria-label*="Complete order" i]',
    'button:has-text("Pay now")',
    'button:has-text("Pay Now")',
    'button:has-text("Complete order")',
    'button:has-text("Place order")',
    'button:has-text("Place Order")',
    'button.step__footer__continue-btn',
    'form[data-payment-form] button[type="submit"]',
    '.section--payment-method button[type="submit"]',
  ].join(", ");

  const placeOrderBtn = page.locator(PAY_BTN_SELECTORS).first();
  const btnVisible = await placeOrderBtn.isVisible({ timeout: 12000 }).catch(() => false);

  if (btnVisible) {
    if (task.dryRun) {
      await log("success", "✓ DRY RUN COMPLETE — Pay Now button found. No order placed.");
      return true;
    }
    await log("info", "Clicking Pay Now...");
    await placeOrderBtn.click();
    await FAST_DELAY(3000, 5000);
    const success = page.locator('h2:has-text("Thank you"), h1:has-text("Thank you"), [class*="confirmation"], [class*="thank-you"]').first();
    if (await success.isVisible({ timeout: 10000 }).catch(() => false)) {
      await log("success", "🎉 ORDER PLACED on Topps!");
      return true;
    }
    await log("warn", "Checkout submitted — verify in your Topps account");
    return true;
  }

  const title = await page.title().catch(() => "?");
  if (task.dryRun) {
    await log("error", `✗ DRY RUN FAILED — Pay Now not found on "${title}" (${page.url()})`);
  } else {
    await log("error", `Pay Now button not found — page: "${title}" (${page.url()})`);
  }
  return false;
}

// ── MAIN BOT (speed-first architecture) ──────────────────────────────────────

async function runToppsBotImpl(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<boolean> {
  let browser: Browser | null = null;

  try {
    // ── STEP 1: API scan — get variant ID + product URL (no browser) ─────
    await log("info", `🔎 Scanning Topps API for: "${task.keywords}"`);
    const scan = await scanToppsApi(task.keywords, profile.proxyUrl, profile.toppsCookies);

    if (!scan.variantId) {
      if (scan.apiReachable) return false; // not in stock yet

      // API blocked — fall back to browser if we have a product URL
      if (task.productUrl && task.productUrl.includes("/products/")) {
        await log("warn", `API blocked (${scan.debugError ?? scan.debugStatus}) — falling back to browser`);
        return runToppsBotBrowserFallback(task, profile, log, signal);
      }
      await log("warn", `API unreachable (${scan.debugError ?? scan.debugStatus}) — retrying next cycle`);
      return false;
    }

    // ── STEP 2: Price check ──────────────────────────────────────────────
    if (task.maxPrice != null && scan.price != null && scan.price > task.maxPrice) {
      await log("warn", `Price $${scan.price.toFixed(2)} > max $${task.maxPrice.toFixed(2)} — skipping`);
      return false;
    }

    await log("success", `🟢 FOUND: variant ${scan.variantId} ($${scan.price?.toFixed(2) ?? "?"}) — EXECUTING!`);

    if (signal.aborted) return false;

    // ── STEP 3: Try FAST CHECKOUT first (pure HTTP, ~2 seconds) ──────────
    if (profile.toppsCookies) {
      await log("info", "⚡ Attempting fast checkout (no browser)...");
      const t0 = Date.now();
      try {
        const fastResult = await shopifyFastCheckout(scan.variantId, task, profile, log);
        const elapsed = Date.now() - t0;

        if (fastResult.success) {
          await log("success", `⚡ Fast checkout completed in ${elapsed}ms!`);
          return true;
        }

        await log("warn", `⚡ Fast checkout failed (${elapsed}ms): ${fastResult.error} — falling back to browser`);
      } catch (err) {
        const elapsed = Date.now() - t0;
        await log("warn", `⚡ Fast checkout error (${elapsed}ms): ${err instanceof Error ? err.message : String(err)} — falling back to browser`);
      }
    }

    if (signal.aborted) return false;

    // ── STEP 4: Browser fallback (if fast checkout failed) ───────────────
    const warm = await getWarmSession("topps.com", profile.toppsCookies, profile.proxyUrl, ".topps.com");
    browser = warm.browser;
    const page = warm.page;

    // Navigate to product page (needed for same-origin cart API calls)
    const productUrl = scan.productUrl ?? `https://www.topps.com/products/${scan.handle}`;
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});

    // Handle Cloudflare if present
    if (await isCloudflareBlock(page)) {
      const cleared = await handleCloudflareThenGoTo(page, productUrl, log, profile.proxyUrl);
      if (!cleared) {
        await closeWarmSession("topps.com", profile.proxyUrl);
        return false;
      }
    }

    // Handle login wall
    await loginIfNeeded(page, profile.email, profile.password, productUrl, log);

    // Handle queue
    if (await isInQueue(page)) {
      await log("info", "Queue detected — waiting...");
      const passed = await waitThroughQueue(page, log, signal);
      if (!passed) return false;
    }

    if (signal.aborted) return false;

    // ── STEP 4: Add to cart via API (with retry) ─────────────────────────
    await log("info", `Adding variant ${scan.variantId} × ${task.quantity} to cart...`);
    const cart = await addToCartWithRetry(page, scan.variantId, task.quantity, log);

    if (!cart.success || !cart.checkoutUrl) {
      await log("warn", "Cart add failed — retrying next cycle");
      return false;
    }

    await log("success", `Cart ready — checkout: ${cart.checkoutUrl}`);

    if (signal.aborted) return false;

    // ── STEP 5: Navigate to checkout ─────────────────────────────────────
    const fullCheckoutUrl = cart.checkoutUrl.startsWith("http")
      ? cart.checkoutUrl
      : `https://www.topps.com${cart.checkoutUrl}`;

    await page.evaluate((url) => { window.location.assign(url); }, fullCheckoutUrl);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await FAST_DELAY(500, 1000);

    const cfOk = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
    if (!cfOk) return false;

    if (await isInQueue(page)) {
      await log("info", "Queue at checkout — waiting...");
      const passed = await waitThroughQueue(page, log, signal);
      if (!passed) return false;
    }

    if (signal.aborted) return false;

    // ── STEP 6: Fill checkout + place order ──────────────────────────────
    return await fillCheckout(page, profile, task, log, signal);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Target closed") || msg.includes("Connection closed") || msg.includes("Browser closed")) {
      await log("warn", "Browser crashed — closing warm session, will relaunch next cycle");
      await closeWarmSession("topps.com", profile.proxyUrl);
    } else {
      await log("error", `Bot error: ${msg.slice(0, 200)}`);
    }
    return false;
  }
}

// ── BROWSER FALLBACK (when API is blocked by Cloudflare) ─────────────────────

async function runToppsBotBrowserFallback(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<boolean> {
  let browser: Browser | null = null;
  try {
    const warm = await getWarmSession("topps.com", profile.toppsCookies, profile.proxyUrl, ".topps.com");
    browser = warm.browser;
    const page = warm.page;

    await page.goto(task.productUrl!, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await FAST_DELAY(1000, 2000);

    if (await isCloudflareBlock(page)) {
      const cleared = await handleCloudflareThenGoTo(page, task.productUrl!, log, profile.proxyUrl);
      if (!cleared) { await closeWarmSession("topps.com", profile.proxyUrl); return false; }
    }

    await loginIfNeeded(page, profile.email, profile.password, task.productUrl!, log);

    if (await isInQueue(page)) {
      const passed = await waitThroughQueue(page, log, signal);
      if (!passed) return false;
    }

    // Click "Shop Now" if on a landing page
    const shopNow = page.locator('a:has-text("Shop Now"), button:has-text("Shop Now")').first();
    if (await shopNow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await shopNow.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await FAST_DELAY(500, 1000);
    }

    if (signal.aborted) return false;

    // Get variant via in-browser API (same origin bypasses CF)
    const variantId = await page.evaluate(async () => {
      const anchors = Array.from(document.querySelectorAll("a[href*='/products/']"));
      const handles = new Set<string>();
      const m0 = window.location.pathname.match(/\/products\/([^/?#]+)/);
      if (m0) handles.add(m0[1]);
      for (const a of anchors) {
        const m = (a as HTMLAnchorElement).href.match(/\/products\/([^/?#]+)/);
        if (m) handles.add(m[1]);
      }
      for (const handle of handles) {
        try {
          const res = await fetch(`/products/${handle}.json`);
          if (!res.ok) continue;
          const data = await res.json() as { product?: { variants?: Array<{ id: number; title: string; available: boolean }> } };
          const v = data.product?.variants;
          if (!v?.length) continue;
          const pick = v.find(x => x.title.toLowerCase().includes("hobby") && x.available) ?? v.find(x => x.available);
          if (pick) return String(pick.id);
        } catch {}
      }
      return null;
    }).catch(() => null);

    if (!variantId) {
      await log("warn", "No variant found via browser — not available yet");
      return false;
    }

    await log("success", `Found variant ${variantId} via browser — adding to cart...`);
    const cart = await addToCartWithRetry(page, variantId, task.quantity, log);
    if (!cart.success || !cart.checkoutUrl) { await log("warn", "Cart add failed"); return false; }

    const fullUrl = cart.checkoutUrl.startsWith("http") ? cart.checkoutUrl : `https://www.topps.com${cart.checkoutUrl}`;
    await page.evaluate((url) => { window.location.assign(url); }, fullUrl);
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await FAST_DELAY(500, 1000);

    const cfOk = await handleCloudflareThenGoTo(page, page.url(), log, profile.proxyUrl);
    if (!cfOk) return false;

    return await fillCheckout(page, profile, task, log, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `Browser fallback error: ${msg.slice(0, 200)}`);
    if (msg.includes("Target closed") || msg.includes("Browser closed")) {
      await closeWarmSession("topps.com", profile.proxyUrl);
    }
    return false;
  }
}

/** Public wrapper */
export async function runToppsBot(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<import("./dicksBot").BotResult> {
  const success = await runToppsBotImpl(task, profile, log, signal);
  return { success, qtyPurchased: success ? task.quantity : 0 };
}
