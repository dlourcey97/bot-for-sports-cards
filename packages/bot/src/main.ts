import { db, initDb, tasksTable, profilesTable, botLogsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { startBot, stopBot, isRunning, runDryRun } from "./botRunner.js";
import { logger } from "./logger.js";

initDb();

const args = process.argv.slice(2);
const command = args[0] ?? "status";

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
        logger.info("No tasks configured. Use 'seed' command to create a demo profile and task.");
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
      await new Promise((r) => setTimeout(r, 5000));
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
      logger.info("Card Bot CLI");
      logger.info("Commands: status | seed | dry-run <taskId> | start <taskId> | logs [taskId]");
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
