/**
 * Shopify Fast Checkout — pure HTTP, no browser after session lock.
 *
 * Flow (~2 seconds total):
 *   1. POST /cart/add.js              → add variant to cart          (~200ms)
 *   2. GET  /cart.json                → get checkout_url             (~200ms)
 *   3. GET  checkout_url              → parse tokens + shipping      (~300ms)
 *   4. POST deposit.shopifycs.com     → tokenize credit card         (~300ms)
 *   5. POST checkout (shipping step)  → submit shipping info         (~300ms)
 *   6. POST checkout (payment step)   → submit payment token         (~300ms)
 *   7. POST checkout (confirm)        → place order                  (~200ms)
 */

import type { BotProfile, BotTask, LogFn } from "./dicksBot";

interface FastCheckoutResult {
  success: boolean;
  orderConfirmed: boolean;
  error?: string;
  timings?: Record<string, number>;
}

type HttpHeaders = Record<string, string>;

function buildHeaders(cookiesJson: string, extra?: HttpHeaders): HttpHeaders {
  let cookieHeader = "";
  try {
    const cookies = JSON.parse(cookiesJson);
    if (Array.isArray(cookies)) {
      cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    }
  } catch {}

  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.topps.com/",
    "Origin": "https://www.topps.com",
    "Cookie": cookieHeader,
    ...extra,
  };
}

async function httpFetch(
  url: string,
  options: {
    method?: string;
    headers?: HttpHeaders;
    body?: string;
    proxyUrl?: string | null;
    timeout?: number;
  }
): Promise<{ status: number; headers: Headers; text: string; ok: boolean }> {
  const { fetch: undiciFetch, ProxyAgent, Agent } = await import("undici");
  const dispatcher = options.proxyUrl
    ? new ProxyAgent(options.proxyUrl)
    : new Agent({ keepAliveTimeout: 30_000 });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeout ?? 10000);

  try {
    const res = await (undiciFetch as any)(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      dispatcher,
      signal: ac.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ok: res.ok };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── STEP 1: Add to cart ──────────────────────────────────────────────────────

async function addToCart(
  variantId: string,
  quantity: number,
  cookiesJson: string,
  proxyUrl?: string | null,
): Promise<{ checkoutUrl: string | null; error?: string }> {
  // Add item
  const addRes = await httpFetch("https://www.topps.com/cart/add.js", {
    method: "POST",
    headers: buildHeaders(cookiesJson, { "Content-Type": "application/json" }),
    body: JSON.stringify({ id: parseInt(variantId, 10), quantity }),
    proxyUrl,
  });

  if (!addRes.ok) {
    return { checkoutUrl: null, error: `cart/add.js: HTTP ${addRes.status} — ${addRes.text.slice(0, 100)}` };
  }

  // Get checkout URL
  const cartRes = await httpFetch("https://www.topps.com/cart.json", {
    headers: buildHeaders(cookiesJson, { "Accept": "application/json" }),
    proxyUrl,
  });

  if (!cartRes.ok) {
    return { checkoutUrl: null, error: `cart.json: HTTP ${cartRes.status}` };
  }

  try {
    const cart = JSON.parse(cartRes.text);
    const items = cart.items as unknown[];
    if (!items || items.length === 0) {
      return { checkoutUrl: null, error: "Cart is empty after add" };
    }
    return { checkoutUrl: cart.checkout_url ?? "/checkout" };
  } catch {
    return { checkoutUrl: null, error: "Failed to parse cart.json" };
  }
}

// ── STEP 2: Parse checkout page ──────────────────────────────────────────────

interface CheckoutTokens {
  authenticityToken: string;
  checkoutToken: string;
  shippingRateId?: string;
  paymentGatewayId?: string;
}

function parseCheckoutPage(html: string): CheckoutTokens | null {
  const authToken = html.match(/name="authenticity_token"\s+value="([^"]+)"/)?.[1]
    ?? html.match(/"authenticity_token":"([^"]+)"/)?.[1];

  const checkoutToken = html.match(/name="checkout\[token\]"\s+value="([^"]+)"/)?.[1]
    ?? html.match(/checkout_token['":\s]+"?([a-f0-9]+)/)?.[1];

  // Extract shipping rate
  const shippingRate = html.match(/name="checkout\[shipping_rate\]\[id\]"\s+value="([^"]+)"/)?.[1]
    ?? html.match(/data-shipping-method="([^"]+)"/)?.[1]
    ?? html.match(/"shipping_rate"[^}]*"id":"([^"]+)"/)?.[1];

  // Extract payment gateway ID
  const gateway = html.match(/name="checkout\[payment_gateway\]"\s+value="([^"]+)"/)?.[1]
    ?? html.match(/data-select-gateway="(\d+)"/)?.[1]
    ?? html.match(/"payment_gateway['":\s]+(\d+)/)?.[1];

  if (!authToken) return null;

  return {
    authenticityToken: authToken,
    checkoutToken: checkoutToken ?? "",
    shippingRateId: shippingRate ?? undefined,
    paymentGatewayId: gateway ?? undefined,
  };
}

// ── STEP 3: Tokenize payment card ────────────────────────────────────────────

async function tokenizeCard(
  cardNumber: string,
  cardExpiry: string,
  cardCvv: string,
  cardName: string,
): Promise<string | null> {
  const [expMonth, expYear] = cardExpiry.split("/");

  const payload = JSON.stringify({
    credit_card: {
      number: cardNumber.replace(/\s/g, ""),
      name: cardName,
      month: parseInt(expMonth, 10),
      year: parseInt(expYear.length === 2 ? `20${expYear}` : expYear, 10),
      verification_value: cardCvv,
    },
  });

  try {
    const res = await httpFetch("https://deposit.shopifycs.com/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: payload,
      timeout: 8000,
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text);
    return data.id ?? null;
  } catch {
    return null;
  }
}

// ── MAIN: Fast checkout ──────────────────────────────────────────────────────

export async function shopifyFastCheckout(
  variantId: string,
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
): Promise<FastCheckoutResult> {
  const timings: Record<string, number> = {};
  const cookies = profile.toppsCookies ?? "";
  const proxy = profile.proxyUrl;
  let t0 = Date.now();

  // ── 1. Add to cart ─────────────────────────────────────────────────────
  await log("info", "⚡ Fast checkout: adding to cart...");
  const cart = await addToCart(variantId, task.quantity, cookies, proxy);
  timings.cartAdd = Date.now() - t0;

  if (!cart.checkoutUrl) {
    // Retry once
    await new Promise(r => setTimeout(r, 300));
    const retry = await addToCart(variantId, task.quantity, cookies, proxy);
    timings.cartRetry = Date.now() - t0 - timings.cartAdd;
    if (!retry.checkoutUrl) {
      return { success: false, orderConfirmed: false, error: `Cart failed: ${cart.error}`, timings };
    }
    cart.checkoutUrl = retry.checkoutUrl;
  }

  await log("success", `⚡ Cart ready (${timings.cartAdd}ms) — ${cart.checkoutUrl}`);

  // ── 2. Tokenize card (parallel with checkout fetch) ────────────────────
  t0 = Date.now();
  const [paymentToken, checkoutPage] = await Promise.all([
    tokenizeCard(profile.cardNumber, profile.cardExpiry, profile.cardCvv, profile.cardName),
    httpFetch(
      cart.checkoutUrl.startsWith("http") ? cart.checkoutUrl : `https://www.topps.com${cart.checkoutUrl}`,
      { headers: buildHeaders(cookies), proxyUrl: proxy, timeout: 15000 }
    ),
  ]);
  timings.tokenAndFetch = Date.now() - t0;

  if (!paymentToken) {
    await log("warn", "⚡ Card tokenization failed — falling back to browser checkout");
    return { success: false, orderConfirmed: false, error: "Payment tokenization failed", timings };
  }

  await log("info", `⚡ Card tokenized + checkout fetched (${timings.tokenAndFetch}ms)`);

  if (!checkoutPage.ok) {
    await log("warn", `⚡ Checkout page HTTP ${checkoutPage.status} — may need browser fallback`);
    return { success: false, orderConfirmed: false, error: `Checkout fetch: HTTP ${checkoutPage.status}`, timings };
  }

  // ── 3. Parse checkout tokens ───────────────────────────────────────────
  const tokens = parseCheckoutPage(checkoutPage.text);
  if (!tokens) {
    // Try extracting from the redirect URL or JSON
    await log("warn", "⚡ Could not parse checkout tokens — Shopify may have changed format");
    return { success: false, orderConfirmed: false, error: "Failed to parse checkout page", timings };
  }

  await log("info", `⚡ Checkout tokens parsed (auth: ${tokens.authenticityToken.slice(0, 10)}...)`);

  // ── 4. Submit shipping info ────────────────────────────────────────────
  t0 = Date.now();
  const checkoutBaseUrl = cart.checkoutUrl.startsWith("http")
    ? cart.checkoutUrl
    : `https://www.topps.com${cart.checkoutUrl}`;

  const shippingBody = new URLSearchParams({
    "_method": "patch",
    "authenticity_token": tokens.authenticityToken,
    "previous_step": "contact_information",
    "step": "shipping_method",
    "checkout[email]": profile.email,
    "checkout[shipping_address][first_name]": profile.firstName,
    "checkout[shipping_address][last_name]": profile.lastName,
    "checkout[shipping_address][address1]": profile.address1,
    "checkout[shipping_address][address2]": profile.address2 ?? "",
    "checkout[shipping_address][city]": profile.city,
    "checkout[shipping_address][country]": "US",
    "checkout[shipping_address][province]": profile.state,
    "checkout[shipping_address][zip]": profile.zip,
    "checkout[shipping_address][phone]": profile.phone,
  }).toString();

  const shippingRes = await httpFetch(checkoutBaseUrl, {
    method: "POST",
    headers: buildHeaders(cookies, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: shippingBody,
    proxyUrl: proxy,
    timeout: 10000,
  });
  timings.shipping = Date.now() - t0;
  await log("info", `⚡ Shipping submitted (${timings.shipping}ms) — HTTP ${shippingRes.status}`);

  // Parse updated tokens from shipping response
  const shippingTokens = parseCheckoutPage(shippingRes.text);
  const shippingRateId = shippingTokens?.shippingRateId ?? tokens.shippingRateId;

  // ── 5. Select shipping method ──────────────────────────────────────────
  if (shippingRateId) {
    t0 = Date.now();
    const shippingMethodBody = new URLSearchParams({
      "_method": "patch",
      "authenticity_token": shippingTokens?.authenticityToken ?? tokens.authenticityToken,
      "previous_step": "shipping_method",
      "step": "payment_method",
      "checkout[shipping_rate][id]": shippingRateId,
    }).toString();

    await httpFetch(checkoutBaseUrl, {
      method: "POST",
      headers: buildHeaders(cookies, { "Content-Type": "application/x-www-form-urlencoded" }),
      body: shippingMethodBody,
      proxyUrl: proxy,
      timeout: 10000,
    });
    timings.shippingMethod = Date.now() - t0;
  }

  // ── 6. Submit payment ──────────────────────────────────────────────────
  t0 = Date.now();
  const latestTokens = shippingTokens ?? tokens;
  const gatewayId = latestTokens.paymentGatewayId ?? tokens.paymentGatewayId ?? "";

  const paymentBody = new URLSearchParams({
    "_method": "patch",
    "authenticity_token": latestTokens.authenticityToken,
    "previous_step": "payment_method",
    "step": "",
    "s": paymentToken,
    "checkout[payment_gateway]": gatewayId,
    "checkout[credit_card][vault]": "false",
    "checkout[different_billing_address]": "false",
    "checkout[total_price]": "",
    "complete": "1",
  }).toString();

  if (task.dryRun) {
    const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
    await log("success", `⚡ DRY RUN COMPLETE — would place order now (total: ${totalTime}ms)`);
    await log("info", `⚡ Timings: ${JSON.stringify(timings)}`);
    return { success: true, orderConfirmed: false, timings };
  }

  const paymentRes = await httpFetch(checkoutBaseUrl, {
    method: "POST",
    headers: buildHeaders(cookies, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: paymentBody,
    proxyUrl: proxy,
    timeout: 15000,
  });
  timings.payment = Date.now() - t0;

  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);

  // Check for success
  const isConfirmed = paymentRes.text.includes("thank_you") ||
    paymentRes.text.includes("Thank you") ||
    paymentRes.text.includes("order-confirmation") ||
    paymentRes.text.includes("confirmed");

  if (isConfirmed) {
    await log("success", `🎉 ORDER PLACED via fast checkout! (${totalTime}ms total)`);
    await log("info", `⚡ Timings: ${JSON.stringify(timings)}`);
    return { success: true, orderConfirmed: true, timings };
  }

  // Check if payment was processing (redirect to processing page)
  if (paymentRes.text.includes("processing") || paymentRes.status === 302) {
    await log("warn", `⚡ Order submitted, processing... (${totalTime}ms) — check your Topps account`);
    return { success: true, orderConfirmed: false, timings };
  }

  await log("warn", `⚡ Payment response unclear (HTTP ${paymentRes.status}, ${totalTime}ms) — check your Topps account`);
  await log("info", `⚡ Timings: ${JSON.stringify(timings)}`);
  return { success: false, orderConfirmed: false, error: `Payment HTTP ${paymentRes.status}`, timings };
}
