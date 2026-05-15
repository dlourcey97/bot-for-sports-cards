import { chromium, type Browser, type BrowserContext } from "playwright";

export async function launchStealthBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });
}

export async function createStealthContext(
  browser: Browser,
  proxyUrl?: string | null
): Promise<BrowserContext> {
  const contextOptions: Record<string, unknown> = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Chicago",
  };

  if (proxyUrl) {
    const url = new URL(proxyUrl);
    contextOptions.proxy = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  }

  return browser.newContext(contextOptions);
}

export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
