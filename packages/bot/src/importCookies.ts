/**
 * Quick cookie import — paste cookies from your real browser to bypass Cloudflare.
 *
 * Usage:
 *   npx tsx packages/bot/src/importCookies.ts topps < cookies.json
 *   npx tsx packages/bot/src/importCookies.ts topps '[ ... json ... ]'
 *
 * Workflow:
 *   1. Open topps.com in Chrome (you'll pass CF as a human)
 *   2. Use Cookie-Editor extension → Export → Copy as JSON
 *   3. Paste here — bot uses YOUR cf_clearance to bypass CF
 */

import { readFileSync } from "node:fs";
import { db, initDb, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

initDb();

async function importCookies() {
  const args = process.argv.slice(2);
  const site = args[0] ?? "topps"; // "topps" or "bestbuy"

  // Read cookies from argument or stdin
  let cookieJson: string;
  if (args[1]) {
    cookieJson = args[1];
  } else {
    cookieJson = readFileSync(0, "utf-8"); // stdin
  }

  // Validate JSON
  let cookies: unknown[];
  try {
    cookies = JSON.parse(cookieJson.trim());
    if (!Array.isArray(cookies)) throw new Error("not an array");
  } catch (e) {
    logger.error("Invalid JSON. Export cookies as JSON array from Cookie-Editor extension.");
    process.exit(1);
  }

  // Check for cf_clearance
  const cfClearance = (cookies as any[]).find(c => c.name === "cf_clearance");
  if (cfClearance) {
    logger.info(`✅ cf_clearance found (expires: ${new Date((cfClearance.expirationDate ?? 0) * 1000).toLocaleString()})`);
  } else {
    logger.warn("⚠️  No cf_clearance cookie found — CF bypass may not work. Make sure you visited topps.com and passed the challenge first.");
  }

  // Normalize cookies
  const normalized = (cookies as any[]).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? "/",
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite ?? "Lax",
  }));

  const cookieString = JSON.stringify(normalized);

  // Save to DB
  const profiles = await db.select().from(profilesTable);
  if (profiles.length === 0) {
    logger.error("No profile found — run load-config first");
    process.exit(1);
  }

  const updateField = site === "bestbuy"
    ? { bestbuyCookies: cookieString }
    : { toppsCookies: cookieString };

  await db.update(profilesTable)
    .set({ ...updateField, updatedAt: new Date() })
    .where(eq(profilesTable.id, profiles[0].id));

  logger.info(`✅ ${normalized.length} ${site} cookies imported to database`);
  logger.info(`   cf_clearance: ${cfClearance ? "YES" : "NO"}`);
  logger.info(`   Session cookies: ${normalized.filter(c => c.name.includes("session") || c.name.includes("token")).length}`);
  logger.info(`\n   Bot will now use these cookies to bypass Cloudflare.`);
  logger.info(`   Cookies are valid for ~30 minutes. Start the bot now!`);
}

importCookies().catch((err) => {
  logger.error({ err }, "Import failed");
  process.exit(1);
});
