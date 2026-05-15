import type { Page, Browser } from "playwright";

export interface BotProfile {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvv: string;
  cardName: string;
  toppsCookies?: string | null;
  bestbuyCookies?: string | null;
  proxyUrl?: string | null;
}

export interface BotTask {
  id: number;
  keywords: string;
  productUrl?: string | null;
  quantity: number;
  maxPrice?: number | null;
  dryRun?: boolean;
}

export type LogFn = (level: string, message: string) => Promise<void>;

export interface BotResult {
  success: boolean;
  qtyPurchased: number;
}

export async function runDicksBot(
  task: BotTask,
  profile: BotProfile,
  log: LogFn,
  signal: AbortSignal
): Promise<BotResult> {
  await log("info", "Dick's Sporting Goods bot started");
  await log("warn", "Dick's bot is a placeholder — no real implementation yet");
  return { success: false, qtyPurchased: 0 };
}
