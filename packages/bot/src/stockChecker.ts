export type Site = "bestbuy" | "topps" | "dicks";

export async function fastCheckStock(
  site: Site,
  productUrl: string
): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(productUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const html = await res.text();

    if (site === "bestbuy") {
      if (html.includes('"buttonState":"SOLD_OUT"') || html.includes("Sold Out"))
        return false;
      if (html.includes('"buttonState":"ADD_TO_CART"') || html.includes('"ADD_TO_CART"'))
        return true;
    } else if (site === "topps") {
      if (html.includes('"available":true')) return true;
      if (html.includes('"available":false')) return false;
    }

    return null;
  } catch {
    return null;
  }
}

export interface StoreAvailabilityResult {
  available: string[];
  unavailable: string[];
  dallasHasIt: boolean;
  blocked: boolean;
}

export async function checkBestBuyStoreAvailability(
  _productUrl: string,
  _cookiesJson: string,
  _proxyUrl?: string | null
): Promise<StoreAvailabilityResult> {
  return { available: [], unavailable: [], dallasHasIt: false, blocked: false };
}
