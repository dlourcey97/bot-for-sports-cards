import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

describe("Card Bot", () => {
  let db: typeof import("@workspace/db").db;
  let tasksTable: typeof import("@workspace/db").tasksTable;
  let profilesTable: typeof import("@workspace/db").profilesTable;
  let botLogsTable: typeof import("@workspace/db").botLogsTable;
  let initDb: typeof import("@workspace/db").initDb;

  before(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    tasksTable = dbMod.tasksTable;
    profilesTable = dbMod.profilesTable;
    botLogsTable = dbMod.botLogsTable;
    initDb = dbMod.initDb;
    initDb();
  });

  it("should create a profile", async () => {
    await db.insert(profilesTable).values({
      email: "test@example.com",
      password: "pass",
      firstName: "Test",
      lastName: "User",
      phone: "555-0100",
      address1: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75001",
      cardNumber: "4111111111111111",
      cardExpiry: "12/28",
      cardCvv: "123",
      cardName: "Test User",
    });
    const profiles = await db.select().from(profilesTable);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].email, "test@example.com");
  });

  it("should create a task linked to profile", async () => {
    const [profile] = await db.select().from(profilesTable);
    await db.insert(tasksTable).values({
      profileId: profile.id,
      site: "bestbuy",
      keywords: "trading cards",
      quantity: 2,
      status: "idle",
    });
    const tasks = await db.select().from(tasksTable);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].site, "bestbuy");
    assert.equal(tasks[0].quantity, 2);
  });

  it("should insert bot logs", async () => {
    const [task] = await db.select().from(tasksTable);
    await db.insert(botLogsTable).values({
      taskId: task.id,
      level: "info",
      message: "Test log entry",
    });
    const logs = await db.select().from(botLogsTable);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "Test log entry");
  });

  it("should export types for BotTask and BotProfile", async () => {
    const { runDicksBot } = await import("../dicksBot.js");
    assert.equal(typeof runDicksBot, "function");
  });

  it("should export stockChecker functions", async () => {
    const { fastCheckStock, checkBestBuyStoreAvailability } = await import(
      "../stockChecker.js"
    );
    assert.equal(typeof fastCheckStock, "function");
    assert.equal(typeof checkBestBuyStoreAvailability, "function");
  });

  it("should export stealthBrowser functions", async () => {
    const { launchStealthBrowser, createStealthContext, humanDelay } =
      await import("../stealthBrowser.js");
    assert.equal(typeof launchStealthBrowser, "function");
    assert.equal(typeof createStealthContext, "function");
    assert.equal(typeof humanDelay, "function");
  });
});
