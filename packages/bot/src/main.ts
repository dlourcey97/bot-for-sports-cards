import { readFileSync } from "node:fs";
import { db, initDb, tasksTable, profilesTable, botLogsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { startBot, stopBot, isRunning, runDryRun } from "./botRunner.js";
import { logger } from "./logger.js";

initDb();

const args = process.argv.slice(2);
const command = args[0] ?? "status";

interface ConfigProfile {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvv: string;
  cardName: string;
  bestbuyCookies?: string;
  toppsCookies?: string;
  proxyUrl?: string;
}

interface ConfigTask {
  site: string;
  keywords: string;
  productUrl?: string;
  quantity: number;
  maxPrice?: number | null;
}

interface Config {
  profile: ConfigProfile;
  tasks: ConfigTask[];
}

function maskCard(num: string): string {
  return `**** **** **** ${num.replace(/\s/g, "").slice(-4)}`;
}

async function loadConfig(configPath: string) {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    logger.error(`Could not read config file: ${configPath}`);
    process.exit(1);
  }

  let config: Config;
  try {
    config = parseYaml(raw) as Config;
  } catch (e) {
    logger.error(`Invalid YAML in ${configPath}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  if (!config.profile) {
    logger.error("Config file missing 'profile' section");
    process.exit(1);
  }
  if (!config.tasks || config.tasks.length === 0) {
    logger.error("Config file missing 'tasks' section (need at least one task)");
    process.exit(1);
  }

  const p = config.profile;
  const required: Array<[string, unknown]> = [
    ["email", p.email], ["password", p.password],
    ["firstName", p.firstName], ["lastName", p.lastName],
    ["phone", p.phone], ["address1", p.address1],
    ["city", p.city], ["state", p.state], ["zip", p.zip],
    ["cardNumber", p.cardNumber], ["cardExpiry", p.cardExpiry],
    ["cardCvv", p.cardCvv], ["cardName", p.cardName],
  ];
  for (const [name, val] of required) {
    if (!val || String(val).trim() === "") {
      logger.error(`Profile field '${name}' is required but empty`);
      process.exit(1);
    }
  }

  for (const [i, t] of config.tasks.entries()) {
    if (!t.site || !["bestbuy", "topps", "dicks"].includes(t.site)) {
      logger.error(`Task ${i + 1}: 'site' must be "bestbuy", "topps", or "dicks"`);
      process.exit(1);
    }
    if (!t.keywords && !t.productUrl) {
      logger.error(`Task ${i + 1}: need at least 'keywords' or 'productUrl'`);
      process.exit(1);
    }
  }

  logger.info("Config validated — loading into database...");

  const [inserted] = await db.insert(profilesTable).values({
    email: p.email,
    password: p.password,
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone,
    address1: p.address1,
    address2: p.address2 || null,
    city: p.city,
    state: p.state,
    zip: p.zip,
    cardNumber: p.cardNumber,
    cardExpiry: p.cardExpiry,
    cardCvv: p.cardCvv,
    cardName: p.cardName,
    bestbuyCookies: p.bestbuyCookies || null,
    toppsCookies: p.toppsCookies || null,
    proxyUrl: p.proxyUrl || null,
  }).returning();

  const profileId = inserted.id;
  logger.info(`Profile created: ${p.firstName} ${p.lastName} (${p.email}) — card ${maskCard(p.cardNumber)}`);

  if (p.bestbuyCookies) logger.info("  Best Buy cookies: loaded");
  if (p.toppsCookies) logger.info("  Topps cookies: loaded");
  if (p.proxyUrl) logger.info(`  Proxy: ${p.proxyUrl.replace(/:[^:@]+@/, ":***@")}`);

  const taskIds: number[] = [];
  for (const t of config.tasks) {
    const [task] = await db.insert(tasksTable).values({
      profileId,
      site: t.site,
      keywords: t.keywords || "",
      productUrl: t.productUrl || null,
      quantity: t.quantity || 1,
      maxPrice: t.maxPrice ?? null,
      status: "idle",
    }).returning();
    taskIds.push(task.id);
    logger.info(`Task #${task.id} created: ${t.site} — "${t.keywords || t.productUrl}" × ${t.quantity || 1}`);
  }

  console.log("");
  console.log("  All set! Next steps:");
  console.log("");
  for (const id of taskIds) {
    console.log(`    npx tsx packages/bot/src/main.ts dry-run ${id}   # test checkout flow`);
  }
  console.log("");
  for (const id of taskIds) {
    console.log(`    npx tsx packages/bot/src/main.ts start ${id}     # go live`);
  }
  console.log("");
}

async function main() {
  switch (command) {
    case "status": {
      const tasks = await db.select().from(tasksTable);
      const profiles = await db.select().from(profilesTable);
      logger.info(`Card Bot — ${profiles.length} profile(s), ${tasks.length} task(s)`);
      for (const t of tasks) {
        logger.info(
          { taskId: t.id, site: t.site, status: t.status, url: t.productUrl },
          `Task #${t.id}: ${t.site} — ${t.status}`
        );
      }
      if (tasks.length === 0) {
        logger.info("No tasks configured. Use 'load-config config.yaml' to get started.");
      }
      break;
    }

    case "seed": {
      logger.info("Seeding demo profile and task...");
      const existing = await db.select().from(profilesTable);
      if (existing.length > 0) {
        logger.info("Profile already exists — skipping seed");
        break;
      }
      await db.insert(profilesTable).values({
        email: "demo@example.com",
        password: "demo-password",
        firstName: "Demo",
        lastName: "User",
        phone: "555-0100",
        address1: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
        cardNumber: "4111111111111111",
        cardExpiry: "12/28",
        cardCvv: "123",
        cardName: "Demo User",
      });
      const [profile] = await db.select().from(profilesTable);
      await db.insert(tasksTable).values({
        profileId: profile.id,
        site: "bestbuy",
        keywords: "trading cards hobby box",
        productUrl: "https://www.bestbuy.com/site/trading-cards/1234567",
        quantity: 1,
        status: "idle",
      });
      logger.info("Demo profile and task created. Run 'dry-run 1' to test.");
      break;
    }

    case "import-cookies": {
      const site = args[1] ?? "topps";
      const cookieArg = args[2] ?? "";
      const { execSync } = await import("node:child_process");
      if (cookieArg) {
        execSync(`npx tsx packages/bot/src/importCookies.ts ${site} '${cookieArg.replace(/'/g, "'\\''")}'`, {
          cwd: process.cwd(), stdio: "inherit", env: { ...process.env }, timeout: 15_000,
        });
      } else {
        logger.info("Paste your cookies JSON (from Cookie-Editor export), then press Ctrl+D:");
        execSync(`npx tsx packages/bot/src/importCookies.ts ${site}`, {
          cwd: process.cwd(), stdio: "inherit", env: { ...process.env }, timeout: 120_000,
        });
      }
      break;
    }

    case "warmup": {
      const warmupArg = args[1] ?? "all";
      const extraArg = args[2] ?? "";
      logger.info(`Starting warmup (${warmupArg} ${extraArg})...\n`);
      const { execSync } = await import("node:child_process");
      const timeout = warmupArg === "lock" || extraArg === "lock" ? 1200_000 : 120_000;
      execSync(`npx tsx packages/bot/src/warmup.ts warmup ${warmupArg} ${extraArg}`, {
        cwd: process.cwd(),
        stdio: "inherit",
        env: { ...process.env },
        timeout,
      });
      break;
    }

    case "load-config": {
      const configPath = args[1];
      if (!configPath) {
        logger.error("Usage: load-config <path-to-config.yaml>");
        logger.info("Copy config.example.yaml to config.yaml, fill in your info, then run this command.");
        process.exit(1);
      }
      await loadConfig(configPath);
      break;
    }

    case "dry-run": {
      const taskId = parseInt(args[1], 10);
      if (!taskId) {
        logger.error("Usage: dry-run <taskId>");
        process.exit(1);
      }
      const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
      if (!task) {
        logger.error({ taskId }, "Task not found");
        process.exit(1);
      }
      logger.info({ taskId, site: task.site }, "Starting dry run...");
      await db.update(tasksTable).set({ status: "testing" }).where(eq(tasksTable.id, taskId));
      runDryRun(taskId);
      // Wait for dry run to complete (check status every 2s, max 120s)
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const [check] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
        if (check && check.status === "idle") break;
      }
      await new Promise((r) => setTimeout(r, 1000)); // let final logs flush
      const logs = await db.select().from(botLogsTable).where(eq(botLogsTable.taskId, taskId));
      for (const log of logs) {
        logger.info(`[${log.level}] ${log.message}`);
      }
      break;
    }

    case "start": {
      const taskId = parseInt(args[1], 10);
      if (!taskId) {
        logger.error("Usage: start <taskId>");
        process.exit(1);
      }
      logger.info({ taskId }, "Starting bot...");
      await db.update(tasksTable).set({ status: "running" }).where(eq(tasksTable.id, taskId));
      startBot(taskId);
      logger.info("Bot started. Press Ctrl+C to stop.");
      process.on("SIGINT", () => {
        logger.info("Stopping bot...");
        stopBot(taskId);
        process.exit(0);
      });
      break;
    }

    case "logs": {
      const taskId = parseInt(args[1], 10);
      const logs = taskId
        ? await db.select().from(botLogsTable).where(eq(botLogsTable.taskId, taskId))
        : await db.select().from(botLogsTable).orderBy(desc(botLogsTable.id)).limit(50);
      for (const log of logs) {
        console.log(`[${log.createdAt}] [task:${log.taskId}] [${log.level}] ${log.message}`);
      }
      break;
    }

    default:
      console.log("Card Bot CLI");
      console.log("");
      console.log("Commands:");
      console.log("  load-config <file>       Load profile + tasks from a YAML config file");
      console.log("  import-cookies [site]    Import cookies from your real browser (bypasses CF)");
      console.log("  warmup [site]            Refresh cookies by logging in (bestbuy|topps|all)");
      console.log("  warmup lock [site]       Lock a clean proxy session (keeps browser warm)");
      console.log("  status                   Show all profiles and tasks");
      console.log("  dry-run <taskId>         Test checkout flow without placing an order");
      console.log("  start <taskId>           Start sniping (live mode)");
      console.log("  logs [taskId]            View bot logs");
      console.log("");
      console.log("Drop day workflow (10/10):");
      console.log("  1. Open topps.com in Chrome (pass CF as human)");
      console.log("  2. Export cookies with Cookie-Editor extension");
      console.log("  3. npx tsx packages/bot/src/main.ts import-cookies topps < cookies.json");
      console.log("  4. export CAPSOLVER_API_KEY=\"CAP-...\"");
      console.log("  5. npx tsx packages/bot/src/main.ts start 2");
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
