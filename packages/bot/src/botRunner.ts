import { db, tasksTable, botLogsTable, profilesTable } from "@workspace/db";
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
const lastStoreCheckMap = new Map<number, number>();
const STORE_CHECK_INTERVAL_MS = 60_000;
const purchasedQtyMap = new Map<number, number>();

async function addLog(taskId: number, level: string, message: string) {
  try {
    await db.insert(botLogsTable).values({ taskId, level, message });
  } catch (err) {
    logger.error({ err }, "Failed to write bot log");
  }
}

async function runBotCycle(
  taskId: number,
  signal: AbortSignal,
  cachedTask: Record<string, unknown>,
  cachedProfile: Record<string, unknown>
): Promise<void> {
  await db.update(tasksTable).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(tasksTable.id, taskId));

  const log = (level: string, message: string) => addLog(taskId, level, message);

  const task = cachedTask;
  const profile = cachedProfile;

  const botFn = task.site === "dicks"
    ? runDicksBot
    : task.site === "topps"
      ? runToppsBot
      : runBestBuyBot;

  const profileData = {
    email: profile.email as string,
    password: profile.password as string,
    firstName: profile.firstName as string,
    lastName: profile.lastName as string,
    phone: profile.phone as string,
    address1: profile.address1 as string,
    address2: profile.address2 as string,
    city: profile.city as string,
    state: profile.state as string,
    zip: profile.zip as string,
    cardNumber: profile.cardNumber as string,
    cardExpiry: profile.cardExpiry as string,
    cardCvv: profile.cardCvv as string,
    cardName: profile.cardName as string,
    toppsCookies: profile.toppsCookies as string,
    bestbuyCookies: profile.bestbuyCookies as string,
    proxyUrl: profile.proxyUrl as string,
  };

  const purchasedSoFar = purchasedQtyMap.get(taskId) ?? 0;
  const remainingQty = Math.max(1, (task.quantity as number) - purchasedSoFar);

  const taskData = {
    id: task.id as number,
    keywords: task.keywords as string,
    productUrl: task.productUrl as string,
    quantity: remainingQty,
    maxPrice: task.maxPrice as number,
  };

  const result = await botFn(taskData, profileData, log, signal);

  // Best Buy store availability check (background, non-blocking)
  if (task.site === "bestbuy" && task.productUrl && profile.bestbuyCookies) {
    const now = Date.now();
    const lastCheck = lastStoreCheckMap.get(taskId) ?? 0;
    if (now - lastCheck >= STORE_CHECK_INTERVAL_MS) {
      lastStoreCheckMap.set(taskId, now);
      checkBestBuyStoreAvailability(task.productUrl as string, profile.bestbuyCookies as string, profile.proxyUrl as string)
        .then(({ available, unavailable, dallasHasIt, blocked }) => {
          if (blocked) return addLog(taskId, "info", "Store tracker — all checks blocked");
          if (available.length === 0 && unavailable.length === 0) return;
          const parts: string[] = [];
          if (available.length > 0) parts.push(`IN STOCK: ${available.join(", ")}`);
          if (unavailable.length > 0) parts.push(`no stock: ${unavailable.join(", ")}`);
          const detail = parts.join(" | ");
          if (dallasHasIt) {
            return addLog(taskId, "success", `🚨 *** DALLAS HAS STOCK! *** — ${detail.toUpperCase()}`);
          }
          return addLog(taskId, "info", `Store tracker — ${detail}`);
        })
        .catch(() => {});
    }
  }

  if (result.success && result.qtyPurchased > 0) {
    const newTotal = purchasedSoFar + result.qtyPurchased;
    purchasedQtyMap.set(taskId, newTotal);

    if (newTotal >= (task.quantity as number)) {
      await addLog(taskId, "success", `✅ All ${newTotal}/${task.quantity} purchased — task complete!`);
      await db.update(tasksTable).set({ status: "success", successAt: new Date(), updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
      stopBot(taskId);
    } else {
      await addLog(taskId, "info", `✔ ${newTotal}/${task.quantity} purchased — hunting ${(task.quantity as number) - newTotal} more...`);
    }
  }
}

export function startBot(taskId: number): void {
  if (activeBots.has(taskId)) return;

  purchasedQtyMap.set(taskId, 0);

  const abortController = new AbortController();
  const bot: ActiveBot = { abortController, running: true };
  activeBots.set(taskId, bot);

  async function loop() {
    // Cache task + profile once at startup (re-read every 30s for config changes)
    let cachedTask: Record<string, unknown> | null = null;
    let cachedProfile: Record<string, unknown> | null = null;
    let lastCacheRefresh = 0;
    const CACHE_REFRESH_MS = 30_000;

    let lastHeartbeatMs = 0;
    let checkCount = 0;
    const HEARTBEAT_INTERVAL_MS = 10_000;

    while (bot.running && !abortController.signal.aborted) {
      checkCount++;

      // Refresh cache periodically
      const now = Date.now();
      if (!cachedTask || !cachedProfile || now - lastCacheRefresh > CACHE_REFRESH_MS) {
        const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).catch(() => [null]);
        if (!task || task.status !== "running") {
          bot.running = false;
          activeBots.delete(taskId);
          return;
        }
        cachedTask = task as unknown as Record<string, unknown>;

        const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.id, task.profileId)).catch(() => [null]);
        if (!profile) {
          await addLog(taskId, "error", "Profile not found — stopping");
          await db.update(tasksTable).set({ status: "failed", updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
          stopBot(taskId);
          return;
        }
        cachedProfile = profile as unknown as Record<string, unknown>;
        lastCacheRefresh = now;
      }

      const task = cachedTask!;

      if (task.productUrl) {
        // Fast pre-check: skip for Best Buy with cookies (cart API is the stock signal)
        const skipFastCheck = task.site === "bestbuy" && !!(cachedProfile as any)?.bestbuyCookies;

        let inStock: boolean | null = null;
        if (!skipFastCheck) {
          try {
            inStock = await fastCheckStock(task.site as Site, task.productUrl as string);
          } catch {
            inStock = null;
          }
        }

        if (inStock === false) {
          const hbNow = Date.now();
          if (hbNow - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
            await addLog(taskId, "info", `🔍 Scanning — ${checkCount} checks, no stock`);
            lastHeartbeatMs = hbNow;
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 750);
            abortController.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
          continue;
        }

        if (inStock === true) {
          await addLog(taskId, "info", "🟢 IN STOCK — launching purchase!");
        }
      }

      // Full bot cycle
      try {
        await runBotCycle(taskId, abortController.signal, cachedTask!, cachedProfile!);
      } catch (err) {
        logger.error({ err, taskId }, "Unhandled bot cycle error");
        await addLog(taskId, "error", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!bot.running || abortController.signal.aborted) break;

      const [refreshed] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).catch(() => [null]);
      if (!refreshed || refreshed.status !== "running") break;

      // Cycle timing: Topps 3s, Best Buy 500ms, Dick's 1.5s
      const pauseMs = refreshed.site === "topps" ? 3000 : refreshed.site === "bestbuy" ? 500 : 1500;
      const hbNow = Date.now();
      if (hbNow - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        await addLog(taskId, "info", `🔍 Scanning — ${checkCount} cycles, no stock`);
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
  db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).then(async ([task]) => {
    if (!task) return;
    const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.id, task.profileId));
    if (!profile) {
      await addLog(taskId, "error", "Profile not found");
      await db.update(tasksTable).set({ status: "idle", updatedAt: new Date() }).where(eq(tasksTable.id, taskId));
      return;
    }

    const log = (level: string, message: string) => addLog(taskId, level, message);
    const abortController = new AbortController();

    await addLog(taskId, "info", "Starting dry run...");

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
          bestbuyCookies: profile.bestbuyCookies,
          toppsCookies: profile.toppsCookies,
          proxyUrl: profile.proxyUrl,
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
