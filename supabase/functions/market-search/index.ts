type SearchResult = {
  title: string;
  link: string;
  displayLink: string;
  snippet: string;
  thumbnailLink?: string;
};

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const cache = new Map<string, { expiresAt: number; results: SearchResult[] }>();
const CACHE_TTL_MS = 1000 * 60 * 60;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

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

  const servingConfig = Deno.env.get("VERTEX_SEARCH_SERVING_CONFIG")?.trim();
  const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")?.trim();
  if (!servingConfig || !serviceAccountJson) {
    return json({
      error: "Missing VERTEX_SEARCH_SERVING_CONFIG or GOOGLE_SERVICE_ACCOUNT_JSON"
    }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const query = String(body.query || "").trim();
  if (query.length < 3) {
    return json({ error: "Query must have at least 3 characters" }, 400);
  }

  const cacheKey = `${servingConfig}:${query.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return json({ results: cached.results, cached: true });
  }

  try {
    const accessToken = await getAccessToken(serviceAccountJson);
    const vertexResponse = await fetch(buildSearchUrl(servingConfig), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        pageSize: normalizePageSize(body.pageSize),
        contentSearchSpec: {
          snippetSpec: { returnSnippet: true },
          extractiveContentSpec: { maxExtractiveAnswerCount: 1 }
        }
      })
    });

    if (!vertexResponse.ok) {
      const text = await vertexResponse.text();
      return json({
        error: "Vertex AI Search failed",
        detail: text
      }, vertexResponse.status);
    }

    const vertexData = await vertexResponse.json();
    const results = normalizeVertexResults(vertexData);
    cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      results
    });

    return json({ results, cached: false });
  } catch (error) {
    return json({
      error: "Vertex AI Search request failed",
      detail: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

async function getAccessToken(serviceAccountJson: string): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const serviceAccount = JSON.parse(serviceAccountJson) as ServiceAccount;
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON: missing client_email or private_key");
  }

  const tokenUri = serviceAccount.token_uri || DEFAULT_TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(serviceAccount, tokenUri, now);
  const tokenResponse = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Google OAuth failed: ${text}`);
  }

  const tokenData = await tokenResponse.json();
  tokenCache = {
    accessToken: String(tokenData.access_token || ""),
    expiresAt: Date.now() + (Number(tokenData.expires_in || 3600) * 1000)
  };

  if (!tokenCache.accessToken) {
    throw new Error("Google OAuth response did not include access_token");
  }

  return tokenCache.accessToken;
}

async function signJwt(serviceAccount: ServiceAccount, tokenUri: string, now: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: GOOGLE_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const input = `${encodedHeader}.${encodedClaimSet}`;
  const privateKey = serviceAccount.private_key.replace(/\\n/g, "\n");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input)
  );

  return `${input}.${base64UrlEncode(signature)}`;
}

function buildSearchUrl(servingConfig: string): string {
  const normalized = servingConfig.replace(/^\/+/, "");
  if (/^https?:\/\//i.test(normalized)) {
    return normalized.endsWith(":search") ? normalized : `${normalized}:search`;
  }
  return `https://discoveryengine.googleapis.com/v1/${normalized.endsWith(":search") ? normalized : `${normalized}:search`}`;
}

function normalizePageSize(pageSize: unknown): number {
  const value = Number(pageSize || 10);
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(25, Math.trunc(value)));
}

function normalizeVertexResults(data: any): SearchResult[] {
  return (Array.isArray(data?.results) ? data.results : [])
    .map((result: any) => {
      const document = result?.document || {};
      const structData = document.structData || {};
      const derivedStructData = document.derivedStructData || {};
      const link = firstString(
        derivedStructData.link,
        derivedStructData.url,
        derivedStructData.uri,
        structData.link,
        structData.url,
        structData.uri
      );

      return {
        title: firstString(
          derivedStructData.title,
          structData.title,
          structData.name,
          document.id,
          link
        ),
        link,
        displayLink: getDisplayLink(link) || firstString(derivedStructData.displayLink, structData.displayLink),
        snippet: extractSnippet(derivedStructData) || firstString(
          structData.description,
          structData.snippet,
          structData.summary
        ),
        thumbnailLink: firstString(
          derivedStructData.thumbnailLink,
          derivedStructData.thumbnail,
          derivedStructData.image,
          structData.thumbnailLink,
          structData.thumbnail,
          structData.image
        )
      };
    })
    .filter((item: SearchResult) => item.link);
}

function extractSnippet(derivedStructData: any): string {
  const snippets = derivedStructData?.snippets;
  if (Array.isArray(snippets)) {
    const snippet = snippets.map((item) => firstString(item?.snippet, item?.htmlSnippet)).find(Boolean);
    if (snippet) return snippet;
  }

  const extractiveAnswers = derivedStructData?.extractiveAnswers || derivedStructData?.extractive_answers;
  if (Array.isArray(extractiveAnswers)) {
    const answer = extractiveAnswers.map((item) => firstString(item?.content, item?.text)).find(Boolean);
    if (answer) return answer;
  }

  return firstString(
    derivedStructData?.snippet,
    derivedStructData?.htmlSnippet,
    derivedStructData?.description
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
    }
    if (value && typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      const nested = firstString(
        objectValue.url,
        objectValue.uri,
        objectValue.link,
        objectValue.src,
        objectValue.content,
        objectValue.text,
        objectValue.value
      );
      if (nested) return nested;
    }
  }
  return "";
}

function getDisplayLink(link: string): string {
  if (!link) return "";
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(input: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
