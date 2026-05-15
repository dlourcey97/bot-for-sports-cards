import type { Page } from "playwright";

export type StatusFn = (msg: string) => void | Promise<void>;

export async function handleAnyCaptcha(
  page: Page,
  onStatus?: StatusFn | string | null,
  _proxyUrl?: string | null
): Promise<boolean> {
  const notify = typeof onStatus === "function" ? onStatus : undefined;

  const hasTurnstile = await page
    .locator('iframe[src*="challenges.cloudflare.com"]')
    .count()
    .catch(() => 0);
  if (hasTurnstile > 0) {
    notify?.("Cloudflare Turnstile detected — CAPSOLVER_API_KEY not configured, skipping");
    return false;
  }

  const hasRecaptcha = await page
    .locator('iframe[src*="google.com/recaptcha"]')
    .count()
    .catch(() => 0);
  if (hasRecaptcha > 0) {
    notify?.("reCAPTCHA detected — CAPSOLVER_API_KEY not configured, skipping");
    return false;
  }

  return true;
}

export async function solveTurnstile(
  page: Page,
  onStatusOrProxy?: StatusFn | string | null,
  _proxyUrl?: string | null
): Promise<boolean> {
  if (typeof onStatusOrProxy === "function") {
    onStatusOrProxy("Turnstile solver not configured (needs CAPSOLVER_API_KEY)");
  }
  return false;
}
