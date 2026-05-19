import { db, initDb, profilesTable, tasksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { launchStealthBrowser, createStealthContext, humanDelay, getWarmSession, closeWarmSession } from "./stealthBrowser.js";
import { handleAnyCaptcha, solveTurnstile } from "./capSolver.js";
import { logger } from "./logger.js";
import type { Browser, BrowserContext, Page } from "playwright";

initDb();

// ── COOKIE REFRESH ───────────────────────────────────────────────────────────

async function refreshBestBuyCookies(
  email: string,
  password: string,
  proxyUrl?: string | null
): Promise<string | null> {
  let browser: Browser | null = null;
  try {
    browser = await launchStealthBrowser();
    const context = await createStealthContext(browser, proxyUrl);
    const page = await context.newPage();

    logger.info("Navigating to Best Buy sign-in...");
    await page.goto("https://www.bestbuy.com/identity/signin", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 3000);

    await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));

    const emailInput = page.locator('input[name="fld-e"], input[type="email"], input[id*="email"]').first();
    if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      logger.info("Filling email...");
      await emailInput.fill(email);
      await humanDelay(300, 600);
      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await humanDelay(2000, 3000);
      }
      await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
      const passInput = page.locator('input[name="fld-p1"], input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        logger.info("Filling password...");
        await passInput.fill(password);
        await humanDelay(300, 600);
        await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
        const signinBtn = page.locator('button:has-text("Sign In"), button[type="submit"]').first();
        await signinBtn.click();
        await humanDelay(4000, 6000);
        await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
      }
    }

    const cookies = await context.cookies();
    const cookieJson = JSON.stringify(
      cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain,
        path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      }))
    );
    logger.info(`Exported ${cookies.length} Best Buy cookies`);
    await browser.close();
    return cookieJson;
  } catch (err) {
    logger.error({ err }, "Best Buy cookie refresh failed");
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

async function refreshToppsCookies(
  email: string,
  password: string,
  proxyUrl?: string | null
): Promise<string | null> {
  let browser: Browser | null = null;
  try {
    browser = await launchStealthBrowser();
    const context = await createStealthContext(browser, proxyUrl);
    const page = await context.newPage();

    logger.info("Navigating to Topps...");
    await page.goto("https://www.topps.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(3000, 5000);
    await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));

    const signInLink = page.locator(
      'a:has-text("Sign In"), a:has-text("Log In"), a:has-text("Account"), a[href*="/account"]'
    ).first();
    if (await signInLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await signInLink.click();
      await humanDelay(2000, 3000);
    } else {
      await page.goto("https://www.topps.com/account/login", { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(2000, 3000);
    }
    await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));

    const emailField = page.locator('input[name="customer[email]"], input[type="email"]').first();
    if (await emailField.isVisible({ timeout: 6000 }).catch(() => false)) {
      logger.info("Filling Topps login...");
      await emailField.fill(email);
      await humanDelay(200, 400);
      const passwordField = page.locator('input[name="customer[password]"], input[type="password"]').first();
      if (await passwordField.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passwordField.fill(password);
        await humanDelay(200, 400);
      }
      await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
      const submitBtn = page.locator('button[type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await page.locator('input[type="password"]').first().press("Enter");
      }
      await humanDelay(4000, 6000);
      await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
    }

    await page.goto("https://www.topps.com/collections", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await humanDelay(2000, 3000);

    const cookies = await context.cookies();
    const cookieJson = JSON.stringify(
      cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain,
        path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      }))
    );
    logger.info(`Exported ${cookies.length} Topps cookies`);
    await browser.close();
    return cookieJson;
  } catch (err) {
    logger.error({ err }, "Topps cookie refresh failed");
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// ── PRE-DROP SESSION LOCK ────────────────────────────────────────────────────
// Keeps trying proxy IPs until one passes Cloudflare, then holds the session
// open so the bot can reuse it instantly when the drop starts.

async function lockSession(
  site: string,
  profile: Record<string, any>,
  maxAttempts = 20,
  holdMinutes = 15
) {
  const domain = site === "bestbuy" ? "bestbuy.com" : "topps.com";
  const cookieDomain = site === "bestbuy" ? ".bestbuy.com" : ".topps.com";
  const cookies = site === "bestbuy" ? profile.bestbuyCookies : profile.toppsCookies;
  const siteUrl = site === "bestbuy" ? "https://www.bestbuy.com" : "https://www.topps.com";

  logger.info(`\n🔒 Locking ${site} session — trying up to ${maxAttempts} proxy IPs...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Close any existing session to force a new proxy IP
    await closeWarmSession(domain, profile.proxyUrl);

    logger.info(`  Attempt ${attempt}/${maxAttempts}...`);

    try {
      const { browser, page } = await getWarmSession(domain, cookies, profile.proxyUrl, cookieDomain);

      // getWarmSession navigates to the site — wait for it
      await humanDelay(4000, 6000);

      const title = await page.title().catch(() => "");

      // Check if CF blocked us
      if (title.includes("Just a moment") || title.includes("Attention Required")) {
        // Try waiting for JS challenge to auto-resolve
        logger.info(`    CF challenge detected — waiting...`);
        await humanDelay(6000, 8000);
        const title2 = await page.title().catch(() => "");

        if (title2.includes("Just a moment") || title2.includes("Attention")) {
          // Try CapSolver
          logger.info(`    Trying CapSolver...`);
          await handleAnyCaptcha(page, (msg) => logger.info(`    [CapSolver] ${msg}`));
          await solveTurnstile(page, (msg: string) => logger.info(`    [CapSolver] ${msg}`));
          await humanDelay(3000, 4000);
          const title3 = await page.title().catch(() => "");

          if (title3.includes("Just a moment") || title3.includes("Attention")) {
            logger.info(`    ❌ IP blocked — rotating...`);
            continue;
          }
        }
      }

      // We passed Cloudflare!
      const finalTitle = await page.title().catch(() => "");
      logger.info(`    ✅ PASSED! Page: "${finalTitle}"`);

      // Verify the session works by checking we can see content
      const hasContent = await page.evaluate(() => {
        return document.querySelectorAll("a[href*='/products/']").length > 0 ||
               document.body.innerText.length > 500;
      }).catch(() => false);

      if (!hasContent) {
        logger.info(`    Page loaded but no content — trying next IP...`);
        continue;
      }

      // Export fresh cookies from this session
      const context = page.context();
      const freshCookies = await context.cookies();
      const cookieJson = JSON.stringify(
        freshCookies.map((c) => ({
          name: c.name, value: c.value, domain: c.domain,
          path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        }))
      );

      // Save fresh cookies to DB
      const updateField = site === "bestbuy"
        ? { bestbuyCookies: cookieJson }
        : { toppsCookies: cookieJson };
      await db.update(profilesTable).set({ ...updateField, updatedAt: new Date() }).where(eq(profilesTable.id, profile.id));
      logger.info(`    Saved ${freshCookies.length} fresh cookies to DB`);

      // Hold the session open
      logger.info(`\n🔒 Session locked! Browser is warm and authenticated.`);
      logger.info(`   Holding for ${holdMinutes} minutes — start the bot now!`);
      logger.info(`   Run in another terminal: npx tsx packages/bot/src/main.ts start <taskId>\n`);

      // Keep-alive: reload every 2 minutes to prevent session timeout
      const holdUntil = Date.now() + holdMinutes * 60 * 1000;
      let keepAliveCount = 0;
      while (Date.now() < holdUntil) {
        const remaining = Math.ceil((holdUntil - Date.now()) / 60000);
        if (keepAliveCount % 6 === 0) {
          logger.info(`   ⏳ Session alive — ${remaining} min remaining`);
        }
        keepAliveCount++;

        await new Promise(r => setTimeout(r, 10_000));

        // Ping the page to keep the session alive
        if (keepAliveCount % 12 === 0) {
          try {
            await page.evaluate(() => fetch("/").catch(() => {}));
          } catch {
            logger.warn("   Keep-alive fetch failed — session may have dropped");
          }
        }
      }

      logger.info("   Session hold expired. Closing browser.");
      await browser.close();
      return true;

    } catch (err) {
      logger.warn(`    Error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }

  logger.error(`❌ Could not lock session after ${maxAttempts} attempts. All proxy IPs were blocked.`);
  logger.info("   Try again — proxy IPs rotate, so the next batch may include clean ones.");
  return false;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function warmup() {
  const args = process.argv.slice(2);
  const command = args[1] ?? "all";

  const profiles = await db.select().from(profilesTable);
  if (profiles.length === 0) {
    logger.error("No profiles found — run load-config first");
    process.exit(1);
  }
  const profile = profiles[0];

  // "lock topps" or "lock bestbuy" — pre-drop session lock
  if (command === "lock" || args[2] === "lock") {
    const site = command === "lock" ? (args[2] ?? "topps") : command;
    await lockSession(site, profile);
    return;
  }

  logger.info(`Warming up cookies for: ${command === "all" ? "Best Buy + Topps" : command}`);

  if (command === "bestbuy" || command === "all") {
    logger.info("\n=== Best Buy Cookie Refresh ===");
    const cookies = await refreshBestBuyCookies(profile.email, profile.password, profile.proxyUrl);
    if (cookies) {
      await db.update(profilesTable).set({ bestbuyCookies: cookies, updatedAt: new Date() }).where(eq(profilesTable.id, profile.id));
      logger.info("✅ Best Buy cookies saved");
    } else {
      logger.warn("❌ Best Buy cookie refresh failed");
    }
  }

  if (command === "topps" || command === "all") {
    logger.info("\n=== Topps Cookie Refresh ===");
    const cookies = await refreshToppsCookies(profile.email, profile.password, profile.proxyUrl);
    if (cookies) {
      await db.update(profilesTable).set({ toppsCookies: cookies, updatedAt: new Date() }).where(eq(profilesTable.id, profile.id));
      logger.info("✅ Topps cookies saved");
    } else {
      logger.warn("❌ Topps cookie refresh failed");
    }
  }

  logger.info("\nWarmup complete. Start the bot within 30 minutes for best results.");
}

warmup().catch((err) => {
  logger.error({ err }, "Warmup fatal error");
  process.exit(1);
});
