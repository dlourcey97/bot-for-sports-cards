import { db, initDb, profilesTable, tasksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { launchStealthBrowser, createStealthContext, humanDelay } from "./stealthBrowser.js";
import { handleAnyCaptcha } from "./capSolver.js";
import { logger } from "./logger.js";
import type { Browser, BrowserContext, Page } from "playwright";

initDb();

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

    // Check if we're logged in
    const url = page.url();
    if (url.includes("/identity/signin") || url.includes("/login")) {
      logger.warn("Still on login page — login may have failed");
      // Try one more time with CAPTCHA
      await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
      await humanDelay(3000, 5000);
    }

    // Export all cookies
    const cookies = await context.cookies();
    const cookieJson = JSON.stringify(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
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
    await page.goto("https://www.topps.com", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(3000, 5000);

    await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));

    // Look for sign-in link
    const signInLink = page.locator(
      'a:has-text("Sign In"), a:has-text("Log In"), a:has-text("Account"), a[href*="/account"]'
    ).first();
    if (await signInLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await signInLink.click();
      await humanDelay(2000, 3000);
    } else {
      await page.goto("https://www.topps.com/account/login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await humanDelay(2000, 3000);
    }

    await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));

    const emailField = page.locator(
      'input[name="customer[email]"], input[type="email"][name*="email"], input[id*="email"]'
    ).first();
    if (await emailField.isVisible({ timeout: 6000 }).catch(() => false)) {
      logger.info("Filling Topps login...");
      await emailField.fill(email);
      await humanDelay(200, 400);

      const passwordField = page.locator(
        'input[name="customer[password]"], input[type="password"]'
      ).first();
      if (await passwordField.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passwordField.fill(password);
        await humanDelay(200, 400);
      }

      await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));

      const submitBtn = page.locator(
        'button[type="submit"]:has-text("Sign in"), button[type="submit"]:has-text("Log in"), button[type="submit"]'
      ).first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await passwordField.press("Enter");
      }

      await humanDelay(4000, 6000);
      await handleAnyCaptcha(page, (msg) => logger.info(`[CapSolver] ${msg}`));
    } else {
      logger.info("No login form found — may already be logged in via Shopify");
    }

    // Navigate to a product page to ensure Shopify cookies are set
    await page.goto("https://www.topps.com/collections", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    }).catch(() => {});
    await humanDelay(2000, 3000);

    // Export all cookies
    const cookies = await context.cookies();
    const cookieJson = JSON.stringify(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
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

async function warmup() {
  const args = process.argv.slice(2);
  const site = args[1] ?? "all"; // "bestbuy", "topps", or "all"

  const profiles = await db.select().from(profilesTable);
  if (profiles.length === 0) {
    logger.error("No profiles found — run load-config first");
    process.exit(1);
  }
  const profile = profiles[0];

  logger.info(`Warming up cookies for: ${site === "all" ? "Best Buy + Topps" : site}`);

  if (site === "bestbuy" || site === "all") {
    logger.info("\n=== Best Buy Cookie Refresh ===");
    const cookies = await refreshBestBuyCookies(
      profile.email,
      profile.password,
      profile.proxyUrl
    );
    if (cookies) {
      await db
        .update(profilesTable)
        .set({ bestbuyCookies: cookies, updatedAt: new Date() })
        .where(eq(profilesTable.id, profile.id));
      logger.info("✅ Best Buy cookies saved to database");
    } else {
      logger.warn("❌ Best Buy cookie refresh failed — old cookies still in DB");
    }
  }

  if (site === "topps" || site === "all") {
    logger.info("\n=== Topps Cookie Refresh ===");
    const cookies = await refreshToppsCookies(
      profile.email,
      profile.password,
      profile.proxyUrl
    );
    if (cookies) {
      await db
        .update(profilesTable)
        .set({ toppsCookies: cookies, updatedAt: new Date() })
        .where(eq(profilesTable.id, profile.id));
      logger.info("✅ Topps cookies saved to database");
    } else {
      logger.warn("❌ Topps cookie refresh failed — old cookies still in DB");
    }
  }

  logger.info("\nWarmup complete. Cookies are fresh — start the bot within 30 minutes.");
}

warmup().catch((err) => {
  logger.error({ err }, "Warmup fatal error");
  process.exit(1);
});
