type SearchResult = {
  title: string;
  link: string;
  displayLink: string;
  snippet: string;
  thumbnailLink?: string;
};

const cache = new Map<string, { expiresAt: number; results: SearchResult[] }>();
const CACHE_TTL_MS = 1000 * 60 * 60;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expectedToken = Deno.env.get("MARKET_SEARCH_TOKEN") || "";
  if (expectedToken) {
    const providedToken = request.headers.get("x-api-key") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      "";

    if (providedToken !== expectedToken) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  const searchEngineId = Deno.env.get("GOOGLE_CSE_ID");
  if (!apiKey || !searchEngineId) {
    return json({ error: "Missing GOOGLE_API_KEY or GOOGLE_CSE_ID" }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const query = String(body.query || "").trim();
  if (query.length < 3) {
    return json({ error: "Query must have at least 3 characters" }, 400);
  }

  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return json({ results: cached.results, cached: true });
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", searchEngineId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", "10");
  url.searchParams.set("safe", "active");

  const googleResponse = await fetch(url);
  if (!googleResponse.ok) {
    const text = await googleResponse.text();
    return json({ error: "Google search failed", detail: text }, googleResponse.status);
  }

  const googleData = await googleResponse.json();
  const results = normalizeResults(googleData.items || []);
  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    results
  });

  return json({ results, cached: false });
});

function normalizeResults(items: any[]): SearchResult[] {
  return items.map((item) => ({
    title: item.title || "",
    link: item.link || "",
    displayLink: item.displayLink || "",
    snippet: item.snippet || "",
    thumbnailLink: item.pagemap?.cse_thumbnail?.[0]?.src || ""
  })).filter((item) => item.link);
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
