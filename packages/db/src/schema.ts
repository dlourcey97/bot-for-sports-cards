import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const profilesTable = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  password: text("password").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone").notNull(),
  address1: text("address1").notNull(),
  address2: text("address2"),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  cardNumber: text("card_number").notNull(),
  cardExpiry: text("card_expiry").notNull(),
  cardCvv: text("card_cvv").notNull(),
  cardName: text("card_name").notNull(),
  toppsCookies: text("topps_cookies"),
  bestbuyCookies: text("bestbuy_cookies"),
  proxyUrl: text("proxy_url"),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const tasksTable = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id")
    .notNull()
    .references(() => profilesTable.id),
  site: text("site").notNull(),
  keywords: text("keywords").notNull(),
  productUrl: text("product_url"),
  quantity: integer("quantity").notNull(),
  maxPrice: real("max_price"),
  status: text("status").notNull(),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  successAt: integer("success_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const botLogsTable = sqliteTable("bot_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasksTable.id),
  level: text("level").notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
});
