import type { Page, Browser } from "playwright";
import { launchStealthBrowser, createStealthContext, humanDelay } from "./stealthBrowser";
import { handleAnyCaptcha } from "./capSolver";
import type { BotProfile, BotTask, LogFn, BotResult } from "./dicksBot";

async function dismissPopups(page: Page) {
  try {
    const selectors = [
      '[aria-label="Close"]',
      'button:has-text("No Thanks")',
      'button:has-text("Close")',
      '.c-close-icon',
      '[data-track*="close"]',
      'button:has-text("Not Now")',
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

/** Extract SKU ID from a Best Buy product URL */
function extractSkuId(url: string): string | null {
  const fromQuery = url.match(/[?&]skuId=(\d+)/);
  if (fromQuery) return fromQuery[1];
  const fromPath = url.match(/\/(\d{7,})\b/);
  if (fromPath) return fromPath[1];
  return null;
}

interface CartApiResult {
  result: "added" | "out_of_stock" | "error" | "not_online_sellable";
  /** How many units were actually added to cart (0 on non-added) */
  qtyAdded: number;
}

/** Build Best Buy cart API request headers from a cookie JSON string */
function bbCartHeaders(cookieHeader: string) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Origin": "https://www.bestbuy.com",
    "Referer": "https://www.bestbuy.com/site/searchpage.jsp?st=trading+cards",
    "Cookie": cookieHeader,
  };
}

/**
 * Try to add `qty` units of `skuId` to cart.  Returns the number actually added,
 * or 0 if unavailable, or -1 on hard error.
 */
async function tryAddQty(skuId: string, cookieHeader: string, qty: number): Promise<{ added: boolean; body: string; status: number }> {
  try {
    const res = await fetch("https://www.bestbuy.com/cart/api/v1/addToCart", {
      method: "POST",
      headers: bbCartHeaders(cookieHeader),
      body: JSON.stringify({ items: [{ skuId, quantity: qty, offerId: null, location: null }] }),
    });
    const body = await res.text().catch(() => "");
    return { added: res.ok, body, status: res.status };
  } catch {
    return { added: false, body: "", status: 0 };
  }
}

/**
 * Add a Best Buy item to cart using Node.js native fetch (bypasses Akamai TLS fingerprinting).
 * On QUANTITY_EXCEEDED, steps down: requested → half → 1 to buy as many as possible.
 * Returns the result and how many units were actually added.
 */
async function addToCartViaApi(
  skuId: string,
  cookiesJson: string,
  quantity: number,
  log: LogFn
): Promise<CartApiResult> {
  try {
    const cookieArr: Array<{ name: string; value: string }> = JSON.parse(cookiesJson);
    const cookieHeader = cookieArr.map((c) => `${c.name}=${c.value}`).join("; ");

    // First attempt — try the full requested quantity
    const first = await tryAddQty(skuId, cookieHeader, quantity);

    if (first.added) {
      // Parse actual qty from response when available; fall back to requested
      let qtyAdded = quantity;
      try {
        const parsed = JSON.parse(first.body);
        const lineQty = parsed?.lineItems?.[0]?.quantity ?? parsed?.items?.[0]?.quantity;
        if (typeof lineQty === "number" && lineQty > 0) qtyAdded = lineQty;
      } catch {}
      await log("success", `Cart API: ${qtyAdded} × SKU ${skuId} added to cart`);
      return { result: "added", qtyAdded };
    }

    const body = first.body;
    const snippet = body.slice(0, 200).replace(/\s+/g, " ");

    // Auth failure — expired or missing session cookies
    if (
      first.status === 401 || first.status === 403 ||
      body.includes("Unauthorized") || body.includes("unauthorized") ||
      body.includes("\"authenticated\":false") || body.includes("not logged in") ||
      body.includes("SESSION_EXPIRED") || body.includes("INVALID_SESSION")
    ) {
      await log("warn", `⚠️ Best Buy session expired (HTTP ${first.status}) — refresh your cookies in the Profile. Response: ${snippet}`);
      return { result: "error", qtyAdded: 0 };
    }

    // API-blocked item — Best Buy won't sell this via the cart API (requires browser product page)
    if (body.includes("ITEM_NOT_SELLABLE")) {
      return { result: "not_online_sellable", qtyAdded: 0 };
    }

    // Genuinely out of stock / not available
    if (body.includes("NOT_AVAILABLE") || body.includes("unavailable")) {
      await log("info", `Cart API: SKU ${skuId} out of stock (HTTP ${first.status}) — ${snippet}`);
      return { result: "out_of_stock", qtyAdded: 0 };
    }

    // Regional/account constraint (CONSTRAINED_ITEM or DHV variant) — silently treat as out of stock
    if (body.includes("CONSTRAINED_ITEM") || body.includes("DHV")) {
      await log("warn", `Cart API: SKU ${skuId} constrained/restricted for this account (HTTP ${first.status})`);
      return { result: "out_of_stock", qtyAdded: 0 };
    }

    // Quantity exceeded — step down progressively: requested → half → 1
    if (body.includes("QUANTITY_EXCEEDED") || body.includes("BBYD_QUANTITY")) {
      const steps = [...new Set([Math.max(1, Math.floor(quantity / 2)), 1])];
      for (const step of steps) {
        await log("warn", `Quantity limit hit (requested ${quantity}) — retrying with ${step}...`);
        const retry = await tryAddQty(skuId, cookieHeader, step);
        if (retry.added) {
          let qtyAdded = step;
          try {
            const parsed = JSON.parse(retry.body);
            const lineQty = parsed?.lineItems?.[0]?.quantity ?? parsed?.items?.[0]?.quantity;
            if (typeof lineQty === "number" && lineQty > 0) qtyAdded = lineQty;
          } catch {}
          await log("success", `Cart API: ${qtyAdded} × SKU ${skuId} added to cart (partial — site limit)`);
          return { result: "added", qtyAdded };
        }
        if (
          retry.body.includes("NOT_SELLABLE") ||
          retry.body.includes("NOT_AVAILABLE") ||
          retry.body.includes("unavailable")
        ) {
          return { result: "out_of_stock", qtyAdded: 0 };
        }
      }
      await log("warn", `All quantity steps rejected — out of stock or account locked`);
      return { result: "out_of_stock", qtyAdded: 0 };
    }

    // Unexpected response — log full status + body so we can diagnose
    await log("warn", `Cart API unexpected response HTTP ${first.status} for SKU ${skuId} — ${snippet}`);
    return { result: "error", qtyAdded: 0 };
  } catch (err) {
    await log("warn", `Cart API error: ${err instanceof Error ? err.message : String(err)}`);
    return { result: "error", qtyAdded: 0 };
  }
}

/**
 * Fast authenticated HTTP check — fetch the product page with session cookies and look for
 * the Add to Cart button state. Returns true if the page shows the item as purchasable.
 * Much faster than launching a browser (~300ms vs 15s).
 */
async function checkPageForAtc(productUrl: string, cookiesJson: string): Promise<boolean> {
  try {
    const cookies: Array<{ name: string; value: string }> = JSON.parse(cookiesJson);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(productUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": cookieHeader,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const html = await res.text();
    if (html.includes('"buttonState":"SOLD_OUT"') || html.includes("Sold Out")) return false;
    return (
      html.includes('"buttonState":"ADD_TO_CART"') ||
      html.includes('"ADD_TO_CART"') ||
      (html.includes("Add to Cart") && !html.includes("Sold Out"))
    );
  } catch {
    return false;
  }
}

/**
 * Fast browser-based Add-to-Cart + checkout.
 * Skips homepage warmup and search navigation — goes directly to the product URL
 * with cookies pre-injected. Used when the cart API returns ITEM_NOT_SELLABLE but the
 * product page shows an active Add to Cart button.
 */
async function fastBrowserAtcAndCheckout(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<BotResult> {
  let browser: Browser | null = null;
  try {
    browser = await launchStealthBrowser();
    const context = await createStealthContext(browser, profile.proxyUrl);

    // Inject session cookies
    try {
      const rawCookies: Array<Record<string, unknown>> = JSON.parse(profile.bestbuyCookies ?? "[]");
      const normalizeSameSite = (v: unknown): "Strict" | "Lax" | "None" => {
        if (!v || v === "null") return "Lax";
        const s = String(v).toLowerCase();
        if (s === "strict") return "Strict";
        if (s === "none" || s === "no_restriction") return "None";
        return "Lax";
      };
      await context.addCookies(
        rawCookies.map((c) => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain ?? ".bestbuy.com"),
          path: String(c.path ?? "/"),
          secure: Boolean(c.secure ?? false),
          httpOnly: Boolean(c.httpOnly ?? false),
          sameSite: normalizeSameSite(c.sameSite),
        }))
      );
      await log("info", `Injected ${rawCookies.length} cookies — navigating directly to product page`);
    } catch (e) {
      await log("warn", `Cookie injection failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const page = await context.newPage();
    if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

    // Go straight to the product page — no homepage warmup needed since cookies handle auth
    await page.goto(task.productUrl!, { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(1000, 2000);
    await dismissPopups(page);
    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));

    // Verify ATC button is still live (stock may have sold out while browser was launching)
    const addToCartBtn = page.locator(
      'button.add-to-cart-button, button[data-button-state="ADD_TO_CART"], button:has-text("Add to Cart")'
    ).first();
    const isAvailable = await addToCartBtn.isVisible({ timeout: 6000 }).catch(() => false);
    if (!isAvailable) {
      await log("warn", "Add to Cart button gone by the time browser loaded — sold out");
      await browser.close().catch(() => {});
      return { success: false, qtyPurchased: 0 };
    }

    await log("success", "🟢 ADD TO CART button live — clicking now!");
    await addToCartBtn.click();
    await humanDelay(2000, 3500);
    await dismissPopups(page);

    if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

    // Go to cart
    const goToCartBtn = page.locator('a:has-text("Go to Cart"), button:has-text("Go to Cart")').first();
    if (await goToCartBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await goToCartBtn.click();
      await humanDelay(1500, 2500);
    } else {
      await page.goto("https://www.bestbuy.com/cart", { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(1500, 2500);
    }

    // Checkout
    const checkoutBtn = page.locator('button:has-text("Checkout"), a:has-text("Checkout")').first();
    if (await checkoutBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await checkoutBtn.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      await humanDelay(2000, 3500);
    }

    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
    if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

    // Sign in if prompted (cookies should keep us logged in, but just in case)
    const emailInput = page.locator('input[name="fld-e"], input[type="email"], input[id*="email"]').first();
    if (await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      await log("info", "Sign-in prompt — entering credentials...");
      await emailInput.fill(profile.email);
      await humanDelay(300, 600);
      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      await continueBtn.click();
      await humanDelay(1500, 2500);
      const passInput = page.locator('input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await passInput.fill(profile.password);
        await humanDelay(300, 600);
        const signinBtn = page.locator('button:has-text("Sign In"), button[type="submit"]').first();
        await signinBtn.click();
        await humanDelay(3000, 5000);
        await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
      }
    } else {
      await log("info", "Session active — already signed in");
    }

    if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

    // Shipping
    await humanDelay(1500, 2500);
    const continueShipping = page.locator('button:has-text("Continue"), button:has-text("Next step"), button:has-text("Save & Continue")').first();
    if (await continueShipping.isVisible({ timeout: 6000 }).catch(() => false)) {
      await continueShipping.click();
      await humanDelay(1500, 2500);
    }

    // Payment
    await log("info", `Entering payment: **** **** **** ${profile.cardNumber.slice(-4)}`);
    await humanDelay(500, 1000);
    const cardInput = page.locator('input[id*="credit-card-number"], input[name*="number"], input[autocomplete="cc-number"]').first();
    if (await cardInput.isVisible({ timeout: 6000 }).catch(() => false)) {
      await cardInput.fill(profile.cardNumber.replace(/\s/g, ""));
      await humanDelay(200, 400);
      const expInput = page.locator('input[id*="expiration"], input[autocomplete="cc-exp"]').first();
      await expInput.fill(profile.cardExpiry.replace("/", ""));
      await humanDelay(200, 400);
      const cvvInput = page.locator('input[id*="cvv"], input[id*="cvc"], input[autocomplete="cc-csc"]').first();
      await cvvInput.fill(profile.cardCvv);
      await humanDelay(200, 400);
    }
    const continuePayment = page.locator('button:has-text("Continue"), button:has-text("Review Order"), button:has-text("Save & Continue")').first();
    if (await continuePayment.isVisible({ timeout: 5000 }).catch(() => false)) {
      await continuePayment.click();
      await humanDelay(1500, 2500);
    }

    if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

    // Place order
    await log("info", "Reviewing and placing order...");
    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
    const placeOrderBtn = page.locator([
      'button:has-text("Place Your Order")',
      'button:has-text("Place Order")',
      'button:has-text("Submit Order")',
      'button[data-track*="place-order"]',
      'button[class*="place-order"]',
      'button[data-test*="place-order"]',
    ].join(", ")).first();

    if (await placeOrderBtn.isVisible({ timeout: 12000 }).catch(() => false)) {
      if ((task as BotTask & { dryRun?: boolean }).dryRun) {
        await log("success", "✓ DRY RUN COMPLETE — Place Order button found. No order placed.");
        await browser.close().catch(() => {});
        return { success: true, qtyPurchased: task.quantity };
      }
      await placeOrderBtn.click();
      await humanDelay(5000, 7000);
      const confirmed = page.locator('[class*="thank-you"], h1:has-text("Thank You"), h1:has-text("Order"), [class*="confirmation"]').first();
      if (await confirmed.isVisible({ timeout: 12000 }).catch(() => false)) {
        await log("success", `🎉 ORDER PLACED on Best Buy! (${task.quantity} unit${task.quantity !== 1 ? "s" : ""})`);
        await browser.close().catch(() => {});
        return { success: true, qtyPurchased: task.quantity };
      }
      await log("warn", "Checkout submitted — verify in your Best Buy account");
      await browser.close().catch(() => {});
      return { success: true, qtyPurchased: task.quantity };
    }

    const title = await page.title().catch(() => "unknown");
    await log("error", `Place Order button not found — page: "${title}" (${page.url()})`);
    await browser.close().catch(() => {});
    return { success: false, qtyPurchased: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("error", `Fast browser ATC error: ${msg.slice(0, 200)}`);
    if (browser) await browser.close().catch(() => {});
    return { success: false, qtyPurchased: 0 };
  }
}

export async function runBestBuyBot(task: BotTask, profile: BotProfile, log: LogFn, signal: AbortSignal): Promise<BotResult> {
  let browser: Browser | null = null;

  // ── API FAST PATH: Node.js fetch + cookie injection ──────────────────────
  // When the user has provided Best Buy session cookies we can skip the blocked
  // product-page navigation entirely: add to cart via Node.js fetch (different
  // TLS fingerprint → not blocked by Akamai) and jump straight to /checkout.
  if (profile.bestbuyCookies && task.productUrl) {
    const skuId = extractSkuId(task.productUrl);
    if (skuId) {
      const cartResult = await addToCartViaApi(skuId, profile.bestbuyCookies, task.quantity, log);
      // Out of stock or unavailable — no point trying the browser, just wait next cycle
      if (cartResult.result === "out_of_stock" || cartResult.result === "error") return { success: false, qtyPurchased: 0 };

      // Item is API-blocked (ITEM_NOT_SELLABLE) — check the product page directly for an ATC button
      // and if it's live, spin up the browser and click it
      if (cartResult.result === "not_online_sellable") {
        const pageHasAtc = await checkPageForAtc(task.productUrl, profile.bestbuyCookies);
        if (!pageHasAtc) return { success: false, qtyPurchased: 0 };
        await log("success", "🟢 ADD TO CART live on product page — launching fast browser checkout!");
        return fastBrowserAtcAndCheckout(task, profile, log, signal);
      }
      if (cartResult.result === "added") {
        const qtyInCart = cartResult.qtyAdded;
        // Now launch browser, inject cookies, and go straight to checkout
        try {
          browser = await launchStealthBrowser();
          const context = await createStealthContext(browser, profile.proxyUrl);

          // ── Inject session cookies — normalize sameSite to Playwright-valid values
          try {
            const rawCookies: Array<Record<string, unknown>> = JSON.parse(profile.bestbuyCookies);
            const normalizeSameSite = (v: unknown): "Strict" | "Lax" | "None" => {
              if (!v || v === "null") return "Lax";
              const s = String(v).toLowerCase();
              if (s === "strict") return "Strict";
              if (s === "none" || s === "no_restriction") return "None";
              return "Lax";
            };
            await context.addCookies(
              rawCookies.map((c) => ({
                name: String(c.name),
                value: String(c.value),
                domain: String(c.domain ?? ".bestbuy.com"),
                path: String(c.path ?? "/"),
                secure: Boolean(c.secure ?? false),
                httpOnly: Boolean(c.httpOnly ?? false),
                sameSite: normalizeSameSite(c.sameSite),
              }))
            );
            await log("info", `Injected ${rawCookies.length} session cookies into browser`);
          } catch (e) {
            await log("warn", `Cookie injection failed: ${e instanceof Error ? e.message : String(e)}`);
          }

          const page = await context.newPage();
          await log("info", "Navigating to Best Buy cart → checkout...");

          // Navigate to cart first so Best Buy sees the session + cart items before checkout
          await page.goto("https://www.bestbuy.com/cart", { waitUntil: "domcontentloaded", timeout: 30000 });
          await humanDelay(2000, 3500);
          await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));

          // Click Checkout from the cart page if visible
          const cartCheckoutBtn = page.locator('button:has-text("Checkout"), a:has-text("Checkout")').first();
          if (await cartCheckoutBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
            await log("info", "Clicking Checkout from cart...");
            await cartCheckoutBtn.click();
            await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
            await humanDelay(2500, 4000);
          } else {
            // Already past cart or redirected — go directly to checkout
            await page.goto("https://www.bestbuy.com/checkout/", { waitUntil: "domcontentloaded", timeout: 30000 });
            await humanDelay(2500, 4000);
          }

          await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
          await log("info", `Checkout page: ${page.url()}`);

          // ── Sign in if prompted ───────────────────────────────────────────
          await log("info", `Checking sign-in state for ${profile.email}...`);
          const emailInput = page.locator('input[name="fld-e"], input[type="email"], input[id*="email"]').first();
          if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await log("info", "Sign-in required — entering credentials...");
            await emailInput.fill(profile.email);
            await humanDelay(300, 600);
            const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
            await continueBtn.click();
            await humanDelay(1500, 2500);
            const passInput = page.locator('input[type="password"]').first();
            if (await passInput.isVisible({ timeout: 4000 }).catch(() => false)) {
              await passInput.fill(profile.password);
              await humanDelay(300, 600);
              const signinBtn = page.locator('button:has-text("Sign In"), button[type="submit"]').first();
              await signinBtn.click();
              await humanDelay(3000, 5000);
              await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
            }
          } else {
            await log("info", "Session active — already signed in");
          }

          if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

          // ── Shipping step ─────────────────────────────────────────────────
          await log("info", "Confirming shipping...");
          await humanDelay(2000, 3000);
          const continueShipping = page.locator('button:has-text("Continue"), button:has-text("Next step"), button:has-text("Save & Continue")').first();
          if (await continueShipping.isVisible({ timeout: 8000 }).catch(() => false)) {
            await continueShipping.click();
            await humanDelay(2000, 3000);
          }

          // ── Payment step ──────────────────────────────────────────────────
          await log("info", `Entering payment: **** **** **** ${profile.cardNumber.slice(-4)}`);
          await humanDelay(800, 1500);
          const cardInput = page.locator('input[id*="credit-card-number"], input[name*="number"], input[autocomplete="cc-number"]').first();
          if (await cardInput.isVisible({ timeout: 8000 }).catch(() => false)) {
            await cardInput.fill(profile.cardNumber.replace(/\s/g, ""));
            await humanDelay(300, 600);
            const expInput = page.locator('input[id*="expiration"], input[autocomplete="cc-exp"]').first();
            await expInput.fill(profile.cardExpiry.replace("/", ""));
            await humanDelay(200, 500);
            const cvvInput = page.locator('input[id*="cvv"], input[id*="cvc"], input[autocomplete="cc-csc"]').first();
            await cvvInput.fill(profile.cardCvv);
            await humanDelay(200, 400);
          }
          const continuePayment = page.locator('button:has-text("Continue"), button:has-text("Review Order"), button:has-text("Save & Continue")').first();
          if (await continuePayment.isVisible({ timeout: 6000 }).catch(() => false)) {
            await continuePayment.click();
            await humanDelay(2000, 3000);
          }

          if (signal.aborted) { await browser.close().catch(() => {}); return { success: false, qtyPurchased: 0 }; }

          // ── Place Order ───────────────────────────────────────────────────
          await log("info", `Review page: ${page.url()}`);
          await log("info", "Looking for Place Order button...");
          await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));

          // Best Buy uses various selectors depending on the checkout version
          const placeOrderBtn = page.locator([
            'button:has-text("Place Your Order")',
            'button:has-text("Place Order")',
            'button:has-text("Submit Order")',
            'button[data-track*="place-order"]',
            'button[data-track*="Place Order"]',
            'button[class*="place-order"]',
            '.checkout-buttons__checkout button',
            'button[data-test*="place-order"]',
          ].join(", ")).first();

          if (await placeOrderBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
            if (task.dryRun) {
              await log("success", "✓ DRY RUN COMPLETE — Place Order button found. No order was placed.");
              await browser.close().catch(() => {});
              return { success: true, qtyPurchased: qtyInCart };
            }
            await placeOrderBtn.click();
            await humanDelay(5000, 7000);
            const confirmed = page.locator('[class*="thank-you"], h1:has-text("Thank You"), h1:has-text("Order"), [class*="confirmation"], [class*="order-confirmation"]').first();
            if (await confirmed.isVisible({ timeout: 15000 }).catch(() => false)) {
              await log("success", `🎉 ORDER PLACED SUCCESSFULLY on Best Buy! (${qtyInCart} unit${qtyInCart !== 1 ? "s" : ""})`);
              await browser.close().catch(() => {});
              return { success: true, qtyPurchased: qtyInCart };
            }
            await log("error", "Could not confirm order — check your Best Buy account");
            await browser.close().catch(() => {});
            return { success: false, qtyPurchased: 0 };
          }

          // Log page title to help diagnose what page we actually landed on
          const pageTitle = await page.title().catch(() => "unknown");
          await log("error", `Place Order button not found — current page: "${pageTitle}" (${page.url()})`);
          await browser.close().catch(() => {});
          return { success: false, qtyPurchased: 0 };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await log("error", `Checkout error: ${msg.slice(0, 200)}`);
          if (browser) await browser.close().catch(() => {});
          return { success: false, qtyPurchased: 0 };
        }
      }
      // Cart API failed — fall through to browser approach
    }
  }

  try {
    browser = await launchStealthBrowser();
    const context = await createStealthContext(browser, profile.proxyUrl);
    const page = await context.newPage();

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── NAVIGATE ──────────────────────────────────────────────────────────────
    // Always warm up on the homepage first — Akamai flags direct deep-links
    await log("info", "Navigating to bestbuy.com...");
    await page.goto("https://www.bestbuy.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(1500, 2500);
    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
    await dismissPopups(page);

    // Simulate human behavior on the homepage before touching any product page
    await page.mouse.move(300 + Math.random() * 400, 200 + Math.random() * 200);
    await humanDelay(200, 500);
    await page.mouse.move(500 + Math.random() * 300, 350 + Math.random() * 200);
    await humanDelay(200, 400);
    await page.evaluate(() => window.scrollBy({ top: 300 + Math.random() * 200, behavior: "smooth" }));
    await humanDelay(800, 1500);
    await page.evaluate(() => window.scrollBy({ top: -(150 + Math.random() * 100), behavior: "smooth" }));
    await humanDelay(600, 1200);

    // Then navigate to the product page if a direct URL is set
    if (task.productUrl) {
      // Visit the search page as an intermediate step — less suspicious than a direct product jump
      await log("info", "Browsing to product via search...");
      const searchUrl = `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(task.keywords)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(2000, 3500);
      await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
      await dismissPopups(page);

      // Simulate scrolling through search results
      await page.mouse.move(400 + Math.random() * 300, 300 + Math.random() * 200);
      await humanDelay(300, 600);
      await page.evaluate(() => window.scrollBy({ top: 250 + Math.random() * 150, behavior: "smooth" }));
      await humanDelay(600, 1200);

      await log("info", "Loading product page...");
      // Use JS navigation instead of direct goto — looks like a user click to Akamai
      await page.evaluate((url: string) => { window.location.href = url; }, task.productUrl);
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      await humanDelay(1500, 3000);
      await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
      await dismissPopups(page);
    }

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── SEARCH ────────────────────────────────────────────────────────────────
    if (!task.productUrl) {
      await log("info", `Searching for: "${task.keywords}"`);
      const searchBox = page.locator([
        'input[name="st"]',
        'input[id="gh-search-input"]',
        'input[aria-label*="Search" i]',
        'input[placeholder*="Search" i]',
        'input[class*="search-input"]',
        'input[data-testid*="search"]',
        'form[role="search"] input[type="text"]',
        'header input[type="text"]',
        'input[type="search"]',
      ].join(", ")).first();
      await searchBox.waitFor({ timeout: 15000 });
      await searchBox.click();
      await humanDelay(200, 500);
      for (const char of task.keywords) {
        await page.keyboard.type(char, { delay: Math.random() * 80 + 40 });
      }
      await humanDelay(400, 800);
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 });
      await humanDelay(2000, 3500);
      await dismissPopups(page);

      // ── FIND PRODUCT ────────────────────────────────────────────────────────
      await log("info", "Scanning search results...");
      const productLink = page.locator([
        'a.image-link[href*="/site/"]',
        'h4.sku-title a',
        '.sku-title a',
        'a[href*="/site/"][class*="product"]',
        '[data-testid*="product"] a',
        '.shop-sku-list-item a',
        'ol.sku-list li a',
      ].join(", ")).filter({ hasText: /riftbound|league|legends|topps|chrome|hanger/i }).first();
      const genericLink = page.locator([
        'a.image-link[href*="/site/"]',
        'h4.sku-title a',
        '.sku-title a',
        'a[href*="/site/"][class*="product"]',
        '[data-testid*="product"] a',
      ].join(", ")).first();
      const link = (await productLink.count()) > 0 ? productLink : genericLink;
      const href = await link.getAttribute("href").catch(() => null);
      if (!href) {
        await log("warn", "No matching product found — item may be out of stock or not listed");
        return { success: false, qtyPurchased: 0 };
      }
      const productPageUrl = href.startsWith("http") ? href : `https://www.bestbuy.com${href}`;
      await log("info", "Found product — navigating to product page");
      await page.goto(productPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(2000, 3000);
      await dismissPopups(page);
    }

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── CHECK STOCK ───────────────────────────────────────────────────────────
    await log("info", "Checking stock availability...");
    const soldOutBtn = page.locator('button[data-button-state="SOLD_OUT"], button:has-text("Sold Out")').first();
    const isSoldOut = await soldOutBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (isSoldOut) {
      await log("warn", "Item is sold out on Best Buy — will retry next cycle");
      return { success: false, qtyPurchased: 0 };
    }

    const addToCartBtn = page.locator('button.add-to-cart-button, button[data-button-state="ADD_TO_CART"], button:has-text("Add to Cart")').first();
    const isAvailable = await addToCartBtn.isVisible({ timeout: 8000 }).catch(() => false);
    if (!isAvailable) {
      await log("warn", "Add to Cart button not found — item may be unavailable");
      return { success: false, qtyPurchased: 0 };
    }

    await log("success", "Item is in stock!");

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── ADD TO CART ───────────────────────────────────────────────────────────
    await log("info", "Adding to cart...");
    await addToCartBtn.click();
    await humanDelay(2500, 4000);
    await dismissPopups(page);

    // ── GO TO CART ────────────────────────────────────────────────────────────
    await log("info", "Proceeding to checkout...");
    const goToCartBtn = page.locator('a:has-text("Go to Cart"), button:has-text("Go to Cart")').first();
    if (await goToCartBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      await goToCartBtn.click();
      await humanDelay(1500, 2500);
    } else {
      await page.goto("https://www.bestbuy.com/cart", { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(1500, 2500);
    }

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    const checkoutBtn = page.locator('button:has-text("Checkout"), a:has-text("Checkout")').first();
    await checkoutBtn.waitFor({ timeout: 10000 });
    await humanDelay(500, 1000);
    await checkoutBtn.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    await humanDelay(2500, 4000);

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── SIGN IN ───────────────────────────────────────────────────────────────
    await log("info", `Signing in as ${profile.email}...`);
    const emailInput = page.locator('input[name="fld-e"], input[type="email"], input[id*="email"]').first();
    if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      await emailInput.click();
      await humanDelay(200, 400);
      await emailInput.fill(profile.email);
      await humanDelay(400, 700);
      const continueEmailBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      await continueEmailBtn.click();
      await humanDelay(1500, 2500);

      const passInput = page.locator('input[name="fld-p1"], input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await passInput.click();
        await humanDelay(200, 400);
        await passInput.fill(profile.password);
        await humanDelay(400, 700);
        const signinBtn = page.locator('button:has-text("Sign In"), button[type="submit"]').first();
        await signinBtn.click();
        await humanDelay(3000, 5000);
        await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));
      }
    } else {
      await log("info", "Already signed in or using guest checkout");
    }

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── SHIPPING ──────────────────────────────────────────────────────────────
    await log("info", `Confirming shipping to ${profile.address1}, ${profile.city}, ${profile.state}`);
    await humanDelay(2000, 3000);
    const continueShipping = page.locator('button:has-text("Continue"), button:has-text("Next step")').first();
    if (await continueShipping.isVisible({ timeout: 6000 }).catch(() => false)) {
      await continueShipping.click();
      await humanDelay(1500, 2500);
    }

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── PAYMENT ───────────────────────────────────────────────────────────────
    await log("info", `Entering payment: **** **** **** ${profile.cardNumber.slice(-4)}`);
    await humanDelay(800, 1500);

    const cardNumberInput = page.locator(
      'input[id*="credit-card-number"], input[name*="number"], input[autocomplete="cc-number"], input[placeholder*="Card number"]'
    ).first();
    if (await cardNumberInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      await cardNumberInput.click();
      await humanDelay(200, 400);
      await cardNumberInput.fill(profile.cardNumber.replace(/\s/g, ""));
      await humanDelay(300, 600);

      const expiryInput = page.locator('input[id*="expiration"], input[autocomplete="cc-exp"], input[placeholder*="MM/YY"]').first();
      await expiryInput.click();
      await humanDelay(200, 400);
      await expiryInput.fill(profile.cardExpiry.replace("/", ""));
      await humanDelay(300, 500);

      const cvvInput = page.locator('input[id*="cvv"], input[id*="cvc"], input[autocomplete="cc-csc"]').first();
      await cvvInput.click();
      await humanDelay(200, 400);
      await cvvInput.fill(profile.cardCvv);
      await humanDelay(300, 500);
    }

    const continuePayment = page.locator('button:has-text("Continue"), button:has-text("Review Order")').first();
    if (await continuePayment.isVisible({ timeout: 5000 }).catch(() => false)) {
      await continuePayment.click();
      await humanDelay(1500, 2500);
    }

    if (signal.aborted) return { success: false, qtyPurchased: 0 };

    // ── PLACE ORDER ───────────────────────────────────────────────────────────
    await log("info", "Reviewing and placing order...");
    await humanDelay(800, 1500);
    await handleAnyCaptcha(page, (msg) => log("info", `[CapSolver] ${msg}`));

    const placeOrderBtn = page.locator(
      'button:has-text("Place Your Order"), button:has-text("Place Order"), button[data-track*="place-order"]'
    ).first();

    if (await placeOrderBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      if (task.dryRun) {
        await log("success", "✓ DRY RUN COMPLETE — Place Order button found and all steps validated. No order was placed.");
        return { success: true, qtyPurchased: task.quantity };
      }
      await placeOrderBtn.click();
      await humanDelay(5000, 7000);
      const successIndicator = page.locator('[class*="thank-you"], h1:has-text("Thank You"), h1:has-text("Order"), [class*="confirmation"]').first();
      if (await successIndicator.isVisible({ timeout: 10000 }).catch(() => false)) {
        await log("success", `Order placed successfully on Best Buy! (${task.quantity} unit${task.quantity !== 1 ? "s" : ""})`);
        return { success: true, qtyPurchased: task.quantity };
      } else {
        await log("warn", "Checkout submitted — check your Best Buy account to verify the order");
        return { success: true, qtyPurchased: task.quantity };
      }
    } else {
      if (task.dryRun) {
        await log("error", "✗ DRY RUN FAILED — Could not find Place Order button. Checkout layout may have changed.");
      } else {
        await log("error", "Could not find Place Order button — the site may have blocked the bot or requires manual steps");
      }
      return { success: false, qtyPurchased: 0 };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ERR_HTTP2_PROTOCOL_ERROR") || msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("ERR_NETWORK_CHANGED")) {
      await log("warn", "Best Buy blocked the browser connection (bot detection) — will retry next cycle");
    } else {
      await log("error", `Bot error: ${msg.slice(0, 200)}`);
    }
    return { success: false, qtyPurchased: 0 };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

