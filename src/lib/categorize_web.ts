/**
 * Attempt to categorize a transaction by searching the web.
 * Tries to find the merchant's category from public search results.
 * Returns the found category or null if nothing conclusive found.
 */
export async function categorizeFromWeb(
  merchant: string,
  amount: number
): Promise<string | null> {
  const query = `"${merchant.replace(/[^a-zA-Z0-9 ]/g, " ")}" card charge`;
  try {
    const response = await fetch(
      `https://ddg-api.com/search?q=${encodeURIComponent(query)}&limit=3`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 MarketBot/1.0",
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!response.ok) return null;
    const data = await response.json() as {
      results?: Array<{ title?: string; snippet?: string }>;
    };
    const snippets = (data.results ?? [])
      .slice(0, 3)
      .map((r) => `${r.title ?? ""} ${r.snippet ?? ""}`)
      .join(" ")
      .toLowerCase();

    // Check for dining keywords
    if (/restaurant|food|dining|cafe|grill|pizza|bar|coffee|bistro/i.test(snippets)) {
      return "Dining";
    }
    // Check for shopping/retail
    if (/store|shop|retail|amazon|target|walmart|costco|best buy/i.test(snippets)) {
      return "Discretionary";
    }
    // Check for subscription/media
    if (/subscription|streaming|netflix|spotify|hulu|disney|apple music/i.test(snippets)) {
      return "Subscriptions";
    }
    // Check for transportation
    if (/uber|lyft|taxi|transport|transit|gas station|parking/i.test(snippets)) {
      return "Transportation";
    }
    // Check for travel/lodging
    if (/hotel|airline|flight|airbnb|travel|booking/i.test(snippets)) {
      return "Travel";
    }
    // Check for health/medical
    if (/pharmacy|doctor|medical|health|cvs|walgreens|hospital/i.test(snippets)) {
      return "Healthcare";
    }
    // Check for utilities
    if (/utility|electric|water|internet|comcast|verizon|att|phone/i.test(snippets)) {
      return "Utilities";
    }

    return null;
  } catch {
    return null;
  }
}
