import { db, tasksTable, botLogsTable, profilesTable } from "@workspace/db"; // profilesTable used in dry run
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { runDicksBot } from "./dicksBot";
import { runBestBuyBot } from "./bestbuyBot";
import { runToppsBot } from "./toppsBot";
import { fastCheckStock, checkBestBuyStoreAvailability, type Site } from "./stockChecker";

interface ActiveBot {
  abortController: AbortController;
  running: boolean;
}

const activeBots = new Map<number, ActiveBot>();

// Tracks when we last ran the store availability check per task (ms timestamp)
const lastStoreCheckMap = new Map<number, number>();
const STORE_CHECK_INTERVAL_MS = 60_000;

// ── Quantity tracking ──────────────────────────────────────────────────────
// Tracks how many units have been purchased so far for each running task.
// Reset to 0 whenever a bot starts from idle/stopped.
const purchasedQtyMap = new Map<number, number>();

async function addLog(taskId: number, level: string, message: string) {
  try {
    await db.insert(botLogsTable).values({ taskId, level, message });
  } catch (err) {
    logger.error({ err }, "Failed to write bot log");
  }
}

async function runBotCycle(taskId: number, signal: AbortSignal): Promise<void> {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task || task.status !== "running") return;

  const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.id, task.profileId));
  if (!profile) {
    await addLog(taskId, "error", "Profile not found — stopping task");
    await db.update(tasksTable).set({ status: "failed", updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
    stopBot(taskId);
    return;
  }

  await db.update(tasksTable).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(tasksTable.id, taskId));

  const log = (level: string, message: string) => addLog(taskId, level, message);

  const botFn = task.site === "dicks"
    ? runDicksBot
    : task.site === "topps"
      ? runToppsBot
      : runBestBuyBot;

  const profileData = {
    email: profile.email,
    password: profile.password,
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    address1: profile.address1,
    address2: profile.address2,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    cardNumber: profile.cardNumber,
    cardExpiry: profile.cardExpiry,
    cardCvv: profile.cardCvv,
    cardName: profile.cardName,
    toppsCookies: profile.toppsCookies,
    bestbuyCookies: profile.bestbuyCookies,
    proxyUrl: profile.proxyUrl,
  };

  // How many have we already purchased this session?
  const purchasedSoFar = purchasedQtyMap.get(taskId) ?? 0;
  const remainingQty = Math.max(1, task.quantity - purchasedSoFar);

  const taskData = {
    id: task.id,
    keywords: task.keywords,
    productUrl: task.productUrl,
    quantity: remainingQty, // only request what we still need
    maxPrice: task.maxPrice,
  };

  const result = await botFn(taskData, profileData, log, signal);

  // ── Best Buy store availability check (every 60s, non-blocking) ────────────
  // Fires in the background so it never slows down the fast-check loop.
  // Logs which cities have the item, with an ALL-CAPS DALLAS alert.
  if (task.site === "bestbuy" && task.productUrl && profile.bestbuyCookies) {
    const now = Date.now();
    const lastCheck = lastStoreCheckMap.get(taskId) ?? 0;
    if (now - lastCheck >= STORE_CHECK_INTERVAL_MS) {
      lastStoreCheckMap.set(taskId, now);
      checkBestBuyStoreAvailability(task.productUrl, profile.bestbuyCookies, profile.proxyUrl)
        .then(({ available, unavailable, dallasHasIt, blocked }) => {
          if (blocked) {
            return addLog(taskId, "info", "Store tracker — all metro checks blocked (proxy may need refreshing)");
          }
          if (available.length === 0 && unavailable.length === 0) return;
          const parts: string[] = [];
          if (available.length > 0) parts.push(`IN STOCK: ${available.join(", ")}`);
          if (unavailable.length > 0) parts.push(`no stock: ${unavailable.join(", ")}`);
          const detail = parts.join(" | ");
          if (dallasHasIt) {
            return addLog(
              taskId,
              "success",
              `🚨 *** DALLAS HAS STOCK! *** — ${detail.toUpperCase()} — PURCHASING NOW!`
            );
          }
          return addLog(taskId, "info", `Store drop tracker — ${detail}`);
        })
        .catch(() => {/* silently skip if check fails */});
    }
  }

  if (result.success && result.qtyPurchased > 0) {
    const newTotal = purchasedSoFar + result.qtyPurchased;
    purchasedQtyMap.set(taskId, newTotal);

    if (newTotal >= task.quantity) {
      // All units acquired — mark the task complete and stop
      await addLog(
        taskId,
        "success",
        `✅ All ${newTotal} of ${task.quantity} unit${task.quantity !== 1 ? "s" : ""} purchased — task complete!`
      );
      await db
        .update(tasksTable)
        .set({ status: "success", successAt: new Date(), updatedAt: new Date() })
        .where(eq(tasksTable.id, taskId));
      stopBot(taskId);
    } else {
      // Partial fill — keep hunting the remainder
      const stillNeed = task.quantity - newTotal;
      await addLog(
        taskId,
        "info",
        `✔ ${newTotal} of ${task.quantity} purchased — still hunting ${stillNeed} more...`
      );
      // Task stays "running" — the loop will call runBotCycle again with reduced qty
    }
  }
}

export function startBot(taskId: number): void {
  if (activeBots.has(taskId)) return;

  // Reset purchased count — fresh hunt from 0
  purchasedQtyMap.set(taskId, 0);

  const abortController = new AbortController();
  const bot: ActiveBot = { abortController, running: true };
  activeBots.set(taskId, bot);

  async function loop() {
    // ── FAST CHECK LOOP ───────────────────────────────────────────────────────
    // If a direct product URL is known, hammer it with lightweight HTTP checks
    // every 750ms. Only launch the full browser/API when we confirm in-stock.
    // If no URL is configured, fall straight through to the full browser cycle.

    // Track heartbeat logging — confirm the bot is alive every 10s
    let lastHeartbeatMs = 0;
    let checkCount = 0;
    const HEARTBEAT_INTERVAL_MS = 10_000;

    while (bot.running && !abortController.signal.aborted) {
      checkCount++;
      const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).catch(() => [null]);
      if (!task || task.status !== "running") {
        bot.running = false;
        activeBots.delete(taskId);
        return;
      }

      if (task.productUrl) {
        // ── Fast pre-check ───────────────────────────────────────────────────
        // Skip the HTTP pre-check for Best Buy when session cookies are present:
        // the cart API itself is the fastest and most reliable stock signal —
        // a plain unauthenticated HTTP fetch adds latency without improving accuracy.
        const [profileForCheck] = await db.select().from(profilesTable).where(eq(profilesTable.id, task.profileId)).catch(() => [null]);
        const skipFastCheck = task.site === "bestbuy" && !!profileForCheck?.bestbuyCookies;

        let inStock: boolean | null = null;
        if (!skipFastCheck) {
          try {
            inStock = await fastCheckStock(task.site as Site, task.productUrl);
          } catch {
            inStock = null; // network hiccup — let browser decide
          }
        }

        if (inStock === false) {
          // Confirmed out of stock — skip browser entirely, wait 750ms, retry
          await db.update(tasksTable).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
          const now = Date.now();
          if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
            await addLog(taskId, "info", `🔍 Still scanning — ${checkCount} checks, no stock found`);
            lastHeartbeatMs = now;
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 750);
            abortController.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
          continue;
        }

        if (inStock === true) {
          await addLog(taskId, "info", "🟢 In stock detected — launching purchase flow now!");
        }
        // inStock === null → can't tell from HTTP, launch browser to be sure
      }

      // ── Full browser / API cycle ──────────────────────────────────────────
      try {
        await runBotCycle(taskId, abortController.signal);
      } catch (err) {
        logger.error({ err, taskId }, "Unhandled bot cycle error");
        await addLog(taskId, "error", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!bot.running || abortController.signal.aborted) break;

      // Check whether the task succeeded inside runBotCycle (it calls stopBot on success)
      const [refreshed] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).catch(() => [null]);
      if (!refreshed || refreshed.status !== "running") break;

      // Pause before next cycle:
      //   Topps    → 5s   (Cloudflare + JS-heavy)
      //   Best Buy → 2s   (cart API is the primary path now — no long Akamai cooldown needed)
      //   Dick's   → 1.5s (no aggressive bot detection)
      const pauseMs = refreshed.site === "topps" ? 5000 : refreshed.site === "bestbuy" ? 500 : 1500;
      // Universal heartbeat — fires after every full cycle regardless of fast-check result
      const hbNow = Date.now();
      if (hbNow - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        await addLog(taskId, "info", `🔍 Still scanning — ${checkCount} cycles complete, no stock found`);
        lastHeartbeatMs = hbNow;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pauseMs);
        abortController.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }

    activeBots.delete(taskId);
  }

  loop().catch((err) => {
    logger.error({ err, taskId }, "Bot loop fatal error");
    activeBots.delete(taskId);
  });
}

export function runDryRun(taskId: number): void {
  // Fire a single dry-run cycle in the background (not a loop)
  // Sets status to "testing" while running, back to "idle" when done.
  db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).then(async ([task]) => {
    if (!task) return;
    const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.id, task.profileId));
    if (!profile) {
      await addLog(taskId, "error", "Profile not found — cannot run dry run");
      await db.update(tasksTable).set({ status: "idle", updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
      return;
    }

    const log = (level: string, message: string) => addLog(taskId, level, message);
    const abortController = new AbortController();

    await addLog(taskId, "info", "Starting dry run — will go through all checkout steps without placing an order...");

    const botFn = task.site === "dicks"
      ? runDicksBot
      : task.site === "topps"
        ? runToppsBot
        : runBestBuyBot;

    try {
      await botFn(
        {
          id: task.id,
          keywords: task.keywords,
          productUrl: task.productUrl,
          quantity: task.quantity,
          dryRun: true,
        },
        {
          email: profile.email,
          password: profile.password,
          firstName: profile.firstName,
          lastName: profile.lastName,
          phone: profile.phone,
          address1: profile.address1,
          address2: profile.address2,
          city: profile.city,
          state: profile.state,
          zip: profile.zip,
          cardNumber: profile.cardNumber,
          cardExpiry: profile.cardExpiry,
          cardCvv: profile.cardCvv,
          cardName: profile.cardName,
        },
        log,
        abortController.signal
      );
    } catch (err) {
      logger.error({ err, taskId }, "Dry run error");
      await addLog(taskId, "error", `Dry run error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await db.update(tasksTable).set({ status: "idle", updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
    }
  }).catch((err) => logger.error({ err, taskId }, "runDryRun setup error"));
}

export function stopBot(taskId: number): void {
  const bot = activeBots.get(taskId);
  if (bot) {
    bot.running = false;
    bot.abortController.abort();
    activeBots.delete(taskId);
    lastStoreCheckMap.delete(taskId);
    purchasedQtyMap.delete(taskId);
  }
}

export function isRunning(taskId: number): boolean {
  return activeBots.has(taskId);
}
