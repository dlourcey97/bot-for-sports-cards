import type { Page } from "playwright";

export type StatusFn = (msg: string) => void | Promise<void>;

const API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const API_BASE = "https://api.capsolver.com";

interface TaskResult {
  token: string;
  userAgent?: string;
}

async function createAndSolve(
  taskPayload: Record<string, unknown>,
  notify?: StatusFn,
  timeoutMs = 30_000
): Promise<TaskResult | null> {
  if (!API_KEY) {
    notify?.("CAPSOLVER_API_KEY not set — cannot solve CAPTCHA");
    return null;
  }

  notify?.("Sending CAPTCHA to CapSolver...");

  const createRes = await fetch(`${API_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: API_KEY, task: taskPayload }),
  });
  const createData = (await createRes.json()) as Record<string, unknown>;

  if (createData.errorId && createData.errorId !== 0) {
    notify?.(`CapSolver error: ${createData.errorDescription ?? createData.errorCode}`);
    return null;
  }

  const taskId = createData.taskId as string;
  if (!taskId) {
    notify?.("CapSolver did not return a taskId");
    return null;
  }

  notify?.(`CapSolver task ${taskId} — polling for result...`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const resultRes = await fetch(`${API_BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: API_KEY, taskId }),
    });
    const resultData = (await resultRes.json()) as Record<string, unknown>;

    if (resultData.status === "ready") {
      const solution = resultData.solution as Record<string, unknown>;
      notify?.("CAPTCHA solved!");
      return {
        token: solution.token as string,
        userAgent: solution.userAgent as string | undefined,
      };
    }

    if (resultData.status === "failed" || (resultData.errorId && resultData.errorId !== 0)) {
      notify?.(`CapSolver solve failed: ${resultData.errorDescription ?? resultData.errorCode ?? "unknown"}`);
      return null;
    }
  }

  notify?.("CapSolver timed out waiting for solution");
  return null;
}

async function extractTurnstileParams(page: Page): Promise<{ siteKey: string; action?: string; cdata?: string } | null> {
  return page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="challenges.cloudflare.com"]'
    );
    if (iframe) {
      const src = iframe.src;
      const keyMatch = src.match(/[?&]k=([^&]+)/);
      if (keyMatch) {
        const actionMatch = src.match(/[?&]action=([^&]+)/);
        const cdataMatch = src.match(/[?&]cData=([^&]+)/);
        return {
          siteKey: keyMatch[1],
          action: actionMatch?.[1] ?? undefined,
          cdata: cdataMatch?.[1] ?? undefined,
        };
      }
    }

    const widget = document.querySelector<HTMLElement>(
      '[data-sitekey], .cf-turnstile[data-sitekey]'
    );
    if (widget) {
      return {
        siteKey: widget.getAttribute("data-sitekey") ?? "",
        action: widget.getAttribute("data-action") ?? undefined,
        cdata: widget.getAttribute("data-cdata") ?? undefined,
      };
    }

    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const text = s.textContent ?? "";
      const keyMatch = text.match(/sitekey['":\s]+['"]?(0x[A-Za-z0-9]+)/);
      if (keyMatch) return { siteKey: keyMatch[1] };
    }

    return null;
  }).catch(() => null);
}

async function extractRecaptchaParams(page: Page): Promise<{ siteKey: string } | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".g-recaptcha[data-sitekey]");
    if (el) return { siteKey: el.getAttribute("data-sitekey") ?? "" };

    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="google.com/recaptcha"]'
    );
    if (iframe) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) return { siteKey: m[1] };
    }

    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const text = s.textContent ?? "";
      const m = text.match(/sitekey['":\s]+['"]?(6L[A-Za-z0-9_-]+)/);
      if (m) return { siteKey: m[1] };
    }

    return null;
  }).catch(() => null);
}

async function injectTurnstileToken(page: Page, token: string): Promise<boolean> {
  return page.evaluate((tk) => {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      'input[name="cf-turnstile-response"], input[name="cf_turnstile_response"], ' +
      '[name*="turnstile"], input[name="g-recaptcha-response"]'
    );
    if (inputs.length > 0) {
      inputs.forEach((el) => { el.value = tk; });
      return true;
    }

    const callbacks = (window as unknown as Record<string, unknown>);
    const cbNames = ["turnstileCallback", "onTurnstileSuccess", "cfCallback"];
    for (const name of cbNames) {
      if (typeof callbacks[name] === "function") {
        (callbacks[name] as (t: string) => void)(tk);
        return true;
      }
    }

    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "cf-turnstile-response";
    hidden.value = tk;
    const form = document.querySelector("form");
    if (form) {
      form.appendChild(hidden);
      return true;
    }

    return false;
  }, token).catch(() => false);
}

async function injectRecaptchaToken(page: Page, token: string): Promise<boolean> {
  return page.evaluate((tk) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      "#g-recaptcha-response, textarea[name='g-recaptcha-response']"
    );
    if (textarea) {
      textarea.value = tk;
      textarea.style.display = "block";
    }

    const callbacks = (window as unknown as Record<string, unknown>);
    if (typeof callbacks.captchaCallback === "function") {
      (callbacks.captchaCallback as (t: string) => void)(tk);
      return true;
    }

    if (typeof (window as any).grecaptcha?.execute === "function") {
      return true;
    }

    return !!textarea;
  }, token).catch(() => false);
}

export async function handleAnyCaptcha(
  page: Page,
  onStatus?: StatusFn | string | null,
  _proxyUrl?: string | null
): Promise<boolean> {
  const notify = typeof onStatus === "function" ? onStatus : undefined;

  const turnstileParams = await extractTurnstileParams(page);
  if (turnstileParams && turnstileParams.siteKey) {
    notify?.(`Cloudflare Turnstile detected (key: ${turnstileParams.siteKey.slice(0, 10)}...)`);
    const result = await createAndSolve(
      {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: page.url(),
        websiteKey: turnstileParams.siteKey,
        ...(turnstileParams.action || turnstileParams.cdata
          ? {
              metadata: {
                ...(turnstileParams.action ? { action: turnstileParams.action } : {}),
                ...(turnstileParams.cdata ? { cdata: turnstileParams.cdata } : {}),
              },
            }
          : {}),
      },
      notify
    );
    if (result) {
      const injected = await injectTurnstileToken(page, result.token);
      notify?.(injected ? "Turnstile token injected" : "Token obtained but injection point not found — submitting anyway");
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    }
    return false;
  }

  const recaptchaParams = await extractRecaptchaParams(page);
  if (recaptchaParams && recaptchaParams.siteKey) {
    notify?.(`reCAPTCHA detected (key: ${recaptchaParams.siteKey.slice(0, 10)}...)`);
    const result = await createAndSolve(
      {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: page.url(),
        websiteKey: recaptchaParams.siteKey,
      },
      notify
    );
    if (result) {
      const injected = await injectRecaptchaToken(page, result.token);
      notify?.(injected ? "reCAPTCHA token injected" : "Token obtained but injection unclear");
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    }
    return false;
  }

  return true;
}

export async function solveTurnstile(
  page: Page,
  onStatusOrProxy?: StatusFn | string | null,
  _proxyUrl?: string | null
): Promise<boolean> {
  const notify = typeof onStatusOrProxy === "function" ? onStatusOrProxy : undefined;
  const proxyUrl = typeof onStatusOrProxy === "string" ? onStatusOrProxy : _proxyUrl;

  const params = await extractTurnstileParams(page);
  if (!params || !params.siteKey) {
    notify?.("No Turnstile widget found on page");
    return false;
  }

  const result = await createAndSolve(
    {
      type: "AntiTurnstileTaskProxyLess",
      websiteURL: page.url(),
      websiteKey: params.siteKey,
      ...(params.action || params.cdata
        ? {
            metadata: {
              ...(params.action ? { action: params.action } : {}),
              ...(params.cdata ? { cdata: params.cdata } : {}),
            },
          }
        : {}),
    },
    notify
  );

  if (!result) return false;

  const injected = await injectTurnstileToken(page, result.token);
  notify?.(injected ? "Turnstile solved and injected" : "Turnstile solved but could not inject token");
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}
