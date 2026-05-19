import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { profilesTable, tasksTable, botLogsTable } from "./schema.js";

export { profilesTable, tasksTable, botLogsTable };

const DB_PATH = process.env.DB_PATH ?? "card-bot.db";
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, {
  schema: { profilesTable, tasksTable, botLogsTable },
});

export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address1 TEXT NOT NULL,
      address2 TEXT,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      zip TEXT NOT NULL,
      card_number TEXT NOT NULL,
      card_expiry TEXT NOT NULL,
      card_cvv TEXT NOT NULL,
      card_name TEXT NOT NULL,
      topps_cookies TEXT,
      bestbuy_cookies TEXT,
      proxy_url TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      site TEXT NOT NULL,
      keywords TEXT NOT NULL,
      product_url TEXT,
      quantity INTEGER NOT NULL,
      max_price REAL,
      status TEXT NOT NULL,
      last_run_at INTEGER,
      success_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS bot_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER
    );
  `);
}
