const http = require("node:http");
const { providers, createCustomProvider } = require("./providers");
const { enrichSearchContext, rerankResultsWithCatalog } = require("./catalog");

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.MARKET_SEARCH_TOKEN || "";
const HEADLESS = process.env.HEADLESS !== "false";
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 30);
const MAX_RESULTS_PER_PROVIDER = Number(process.env.MAX_RESULTS_PER_PROVIDER || 16);
const MAX_PROVIDERS = Number(process.env.MAX_PROVIDERS || 10);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 18000);
const PROVIDER_READY_TIMEOUT_MS = Number(process.env.PROVIDER_READY_TIMEOUT_MS || 9000);

let browserPromise;

// API minima propositalmente sem Express para facilitar empacotamento futuro
// em container/Cloud Run mantendo baixo numero de dependencias.
function createAppServer({ searchProvidersImpl = searchProviders } = {}) {
  return http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, providers: providers.map((provider) => provider.id) });
      return;
    }

    if (request.method !== "POST" || request.url !== "/search") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (TOKEN && getToken(request) !== TOKEN) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const body = await readJson(request);
    const query = String(body.query || "").trim();
    if (query.length < 3) {
      sendJson(response, 400, { error: "Query must have at least 3 characters" });
      return;
    }

    const selectedProviders = selectProviders(body.providers);
    const enrichment = enrichSearchContext({
      query,
      itemContext: body.itemContext || {}
    });
    const startedAt = Date.now();
    const results = await searchProvidersImpl(enrichment.queryPrimary || query, selectedProviders, {
      enrichment,
      originalQuery: query
    });
    const rankedResults = rerankResultsWithCatalog(results, enrichment);

    sendJson(response, 200, {
      results: rankedResults.slice(0, MAX_RESULTS),
      meta: {
        query,
        queryPrimary: enrichment.queryPrimary || query,
        providers: selectedProviders.map((provider) => provider.id),
        elapsedMs: Date.now() - startedAt,
        enrichment
      }
    });
  } catch (error) {
    sendJson(response, 500, {
      error: "Scraper failed",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
  });
}

const server = createAppServer();

if (require.main === module) {
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Porta ${PORT} ja esta em uso. O scraper provavelmente ja esta aberto.`);
      console.error("Para reiniciar a versao atual, execute restart-scraper.bat na raiz do projeto.");
      process.exit(1);
    }

    throw error;
  });

  server.listen(PORT, () => {
    console.log(`Pesquisa de Precos scraper listening on http://localhost:${PORT}`);
  });
}

process.on("SIGINT", async () => {
  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  if (browser) await browser.close();
  process.exit(0);
});

async function searchProviders(query, selectedProviders) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });

  try {
    // Os fornecedores sao consultados em paralelo para reduzir latencia. Cada
    // provider ainda tem limite proprio para nao sobrecarregar a UI.
    const groupedResults = await Promise.all(selectedProviders.map((provider) => {
      return scrapeProvider(context, provider, query).catch((error) => {
        console.warn(`[${provider.id}] search failed:`, error instanceof Error ? error.message : error);
        return [];
      });
    }));
    return dedupeResults(interleaveResults(groupedResults));
  } finally {
    await context.close();
  }
}

async function scrapeProvider(context, provider, query) {
  const page = await context.newPage();
  const url = provider.buildUrl(query);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForSelector(provider.itemSelector, { timeout: PROVIDER_READY_TIMEOUT_MS }).catch(() => null);
    await page.waitForTimeout(1200);

    const results = await page.$$eval(provider.itemSelector, extractCards, {
      providerId: provider.id,
      providerName: provider.name,
      titleSelector: provider.titleSelector,
      linkSelector: provider.linkSelector,
      priceSelector: provider.priceSelector,
      priceWholeSelector: provider.priceWholeSelector,
      priceFractionSelector: provider.priceFractionSelector,
      centsSelector: provider.centsSelector,
      imageSelector: provider.imageSelector,
      maxResults: MAX_RESULTS_PER_PROVIDER
    });

    return results
      .map((item) => normalizeProviderResult(item, provider))
      .filter(Boolean);
  } finally {
    await page.close();
  }
}

function extractCards(nodes, config) {
  // Esta funcao roda dentro do contexto da pagina do fornecedor via $$eval.
  // Mantenha-a independente de variaveis externas do Node.
  const pickText = (root, selector) => {
    if (!selector) return "";
    const elements = Array.from(root.querySelectorAll(selector));
    const element = elements.find((candidate) => candidate.textContent && candidate.textContent.trim());
    return element ? element.textContent.trim().replace(/\s+/g, " ") : "";
  };

  const pickAttr = (root, selector, attr) => {
    if (!selector) return "";
    const elements = Array.from(root.querySelectorAll(selector));
    const element = elements.find((candidate) => candidate.getAttribute(attr));
    return element ? element.getAttribute(attr) : "";
  };

  const toAbsoluteUrl = (value) => {
    if (!value) return "";
    try {
      return new URL(value, window.location.href).href;
    } catch {
      return "";
    }
  };

  const normalizePrice = (value, cents) => {
    const text = [value, cents].filter(Boolean).join(",").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const match = text.match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2,4})?|R\$\s*\d+(?:,\d{2,4})?/i);
    if (match) return match[0].replace(/\s+/g, " ").trim();
    if (/^\d{1,3}(?:\.\d{3})*(?:,\d{2,4})?$/.test(text)) return `R$ ${text}`;
    return "";
  };

  const pickPrice = (root) => {
    const price = normalizePrice(pickText(root, config.priceSelector));
    if (price) return price;
    return normalizePrice(
      pickText(root, config.priceWholeSelector),
      pickText(root, config.priceFractionSelector)
    );
  };

  const cleanTitle = (value) => String(value || "")
    .replace(/\bPatrocinado\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return nodes.slice(0, config.maxResults * 2).map((node) => {
    const title = cleanTitle(pickText(node, config.titleSelector) || pickAttr(node, config.linkSelector, "title"));
    const link = toAbsoluteUrl(pickAttr(node, config.linkSelector, "href"));
    const image = toAbsoluteUrl(pickAttr(node, config.imageSelector, "src") || pickAttr(node, config.imageSelector, "data-src"));
    const price = pickPrice(node);

    return {
      title,
      link,
      displayLink: "",
      snippet: price || node.textContent.trim().replace(/\s+/g, " ").slice(0, 220),
      thumbnailLink: image,
      price,
      provider: config.providerId,
      providerName: config.providerName,
      status: "ok"
    };
  }).filter((item) => item.link && item.title).slice(0, config.maxResults);
}

function normalizeProviderResult(item, provider) {
  if (!item || item.status === "error") return null;

  const link = normalizeProviderLink(item.link, provider);
  const title = normalizeTitle(item.title);
  const price = normalizePriceText(item.price);

  if (!link || !title) return null;
  if (!providerHostAllowed(link, provider)) return null;
  if (provider.productPathPattern && !provider.productPathPattern.test(new URL(link).pathname)) return null;
  if (provider.requirePrice !== false && !price) return null;

  return {
    ...item,
    title,
    link,
    displayLink: hostname(link) || provider.name,
    snippet: price ? `${price} - ${provider.name}` : normalizeSnippet(item.snippet),
    price,
    provider: provider.id,
    providerName: provider.name,
    status: "ok"
  };
}

function normalizeProviderLink(value, provider) {
  if (!value) return "";
  const normalized = provider.normalizeLink ? provider.normalizeLink(value) : value;
  try {
    const url = new URL(normalized);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function providerHostAllowed(value, provider) {
  if (!Array.isArray(provider.allowedHostnames) || provider.allowedHostnames.length === 0) {
    return true;
  }

  const host = hostname(value);
  return provider.allowedHostnames.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/\bPatrocinado\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSnippet(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizePriceText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = text.match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2,4})?|R\$\s*\d+(?:,\d{2,4})?/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function selectProviders(requestedProviders) {
  if (!Array.isArray(requestedProviders) || requestedProviders.length === 0) {
    return providers.slice(0, MAX_PROVIDERS);
  }

  const builtIns = new Map(providers.map((provider) => [provider.id, provider]));
  const selected = [];

  for (const requestedProvider of requestedProviders) {
    if (selected.length >= MAX_PROVIDERS) {
      break;
    }

    const providerId = typeof requestedProvider === "string"
      ? requestedProvider.toLowerCase()
      : String(requestedProvider?.id || "").toLowerCase();
    const builtIn = builtIns.get(providerId);
    if (builtIn) {
      selected.push(builtIn);
      continue;
    }

    if (requestedProvider && typeof requestedProvider === "object") {
      const customProvider = createCustomProvider(requestedProvider);
      if (customProvider) {
        selected.push(customProvider);
      }
    }
  }

  return selected;
}

function interleaveResults(groupedResults) {
  const output = [];
  const maxLength = Math.max(0, ...groupedResults.map((group) => group.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groupedResults) {
      if (group[index]) {
        output.push(group[index]);
      }
    }
  }
  return output;
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = normalizeUrl(result.link);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require("playwright");
    browserPromise = chromium.launch({ headless: HEADLESS });
  }
  return browserPromise;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        request.destroy();
        reject(new Error("Payload too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    request.on("error", reject);
  });
}

function getToken(request) {
  const header = request.headers["authorization"] || request.headers["x-api-key"] || "";
  return String(header).replace(/^Bearer\s+/i, "");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "authorization, x-api-key, content-type");
}

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

module.exports = {
  createAppServer,
  searchProviders,
  scrapeProvider,
  normalizeProviderResult,
  normalizeProviderLink,
  normalizePriceText,
  selectProviders,
  interleaveResults,
  dedupeResults,
  normalizeUrl,
  hostname,
  enrichSearchContext,
  rerankResultsWithCatalog
};
