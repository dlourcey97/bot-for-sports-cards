import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--no-first-run",
  "--window-size=1280,800",
];

const STEALTH_SCRIPTS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ],
  });
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(params);
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
`;

export async function launchStealthBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: STEALTH_ARGS,
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
    javaScriptEnabled: true,
  };

  if (proxyUrl) {
    const url = new URL(proxyUrl);
    contextOptions.proxy = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  }

  const ctx = await browser.newContext(contextOptions);
  await ctx.addInitScript(STEALTH_SCRIPTS);
  return ctx;
}

export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Persistent Browser Pool ──────────────────────────────────────────────────

interface WarmSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  domain: string;
  createdAt: number;
}

const warmSessions = new Map<string, WarmSession>();

export async function getWarmSession(
  domain: string,
  cookiesJson?: string | null,
  proxyUrl?: string | null,
  cookieDomain?: string,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const key = `${domain}:${proxyUrl ?? "direct"}`;
  const existing = warmSessions.get(key);

  if (existing) {
    const connected = existing.browser.isConnected();
    if (connected) {
      return { browser: existing.browser, context: existing.context, page: existing.page };
    }
    warmSessions.delete(key);
  }

  const browser = await launchStealthBrowser();
  const context = await createStealthContext(browser, proxyUrl);

  if (cookiesJson) {
    try {
      const cookies = JSON.parse(cookiesJson);
      if (Array.isArray(cookies) && cookies.length > 0) {
        const normalized = cookies.map((c: Record<string, unknown>) => ({
          name: String(c.name ?? ""),
          value: String(c.value ?? ""),
          domain: String(c.domain || cookieDomain || `.${domain}`),
          path: String(c.path || "/"),
          secure: Boolean(c.secure ?? false),
          httpOnly: Boolean(c.httpOnly ?? false),
          sameSite: normalizeSameSite(c.sameSite),
        }));
        await context.addCookies(normalized);
      }
    } catch {}
  }

  const page = await context.newPage();
  await page.goto(`https://www.${domain}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  }).catch(() => {});

  warmSessions.set(key, { browser, context, page, domain, createdAt: Date.now() });
  return { browser, context, page };
}

export async function closeWarmSession(domain: string, proxyUrl?: string | null): Promise<void> {
  const key = `${domain}:${proxyUrl ?? "direct"}`;
  const session = warmSessions.get(key);
  if (session) {
    warmSessions.delete(key);
    await session.browser.close().catch(() => {});
  }
}

export async function closeAllSessions(): Promise<void> {
  for (const [key, session] of warmSessions) {
    await session.browser.close().catch(() => {});
    warmSessions.delete(key);
  }
}

function normalizeSameSite(v: unknown): "Strict" | "Lax" | "None" {
  if (!v || v === "null") return "Lax";
  const s = String(v).toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "none" || s === "no_restriction") return "None";
  return "Lax";
}
