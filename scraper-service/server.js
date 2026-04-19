const http = require("node:http");
const { chromium } = require("playwright");
const { providers } = require("./providers");

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.MARKET_SEARCH_TOKEN || "";
const HEADLESS = process.env.HEADLESS !== "false";
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 10);
const MAX_PROVIDERS = Number(process.env.MAX_PROVIDERS || 4);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 18000);

let browserPromise;

// API minima propositalmente sem Express para facilitar empacotamento futuro
// em container/Cloud Run mantendo baixo numero de dependencias.
const server = http.createServer(async (request, response) => {
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
    const startedAt = Date.now();
    const results = await searchProviders(query, selectedProviders);

    sendJson(response, 200, {
      results: results.slice(0, MAX_RESULTS),
      meta: {
        query,
        providers: selectedProviders.map((provider) => provider.id),
        elapsedMs: Date.now() - startedAt
      }
    });
  } catch (error) {
    sendJson(response, 500, {
      error: "Scraper failed",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`Pesquisa de Precos scraper listening on http://localhost:${PORT}`);
});

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
    const allResults = [];
    // Os fornecedores sao consultados em sequencia no MVP para reduzir risco
    // de bloqueio por muitos acessos simultaneos a partir da mesma maquina.
    for (const provider of selectedProviders) {
      const providerResults = await scrapeProvider(context, provider, query).catch((error) => [{
        title: `Falha ao pesquisar em ${provider.name}`,
        link: provider.buildUrl(query),
        displayLink: hostname(provider.buildUrl(query)),
        snippet: error instanceof Error ? error.message : String(error),
        provider: provider.id,
        status: "error"
      }]);
      allResults.push(...providerResults);
    }
    return dedupeResults(allResults);
  } finally {
    await context.close();
  }
}

async function scrapeProvider(context, provider, query) {
  const page = await context.newPage();
  const url = provider.buildUrl(query);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(1800);

    const results = await page.$$eval(provider.itemSelector, extractCards, {
      providerId: provider.id,
      providerName: provider.name,
      titleSelector: provider.titleSelector,
      linkSelector: provider.linkSelector,
      priceSelector: provider.priceSelector,
      centsSelector: provider.centsSelector,
      imageSelector: provider.imageSelector,
      maxResults: MAX_RESULTS
    });

    return results
      .filter((item) => item.link && item.title)
      .map((item) => ({
        ...item,
        displayLink: hostname(item.link) || provider.name,
        snippet: item.price ? `${item.price} - ${item.providerName}` : item.snippet
      }));
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
    if (/R\$/i.test(text)) return text;
    if (/\d/.test(text)) return `R$ ${text}`;
    return "";
  };

  return nodes.slice(0, config.maxResults * 2).map((node) => {
    const title = pickText(node, config.titleSelector) || pickAttr(node, config.linkSelector, "title");
    const link = toAbsoluteUrl(pickAttr(node, config.linkSelector, "href"));
    const image = toAbsoluteUrl(pickAttr(node, config.imageSelector, "src") || pickAttr(node, config.imageSelector, "data-src"));
    const price = normalizePrice(
      pickText(node, config.priceSelector),
      pickText(node, config.centsSelector)
    );

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

function selectProviders(requestedProviders) {
  if (!Array.isArray(requestedProviders) || requestedProviders.length === 0) {
    return providers.slice(0, MAX_PROVIDERS);
  }

  const requested = new Set(requestedProviders.map((provider) => String(provider).toLowerCase()));
  return providers.filter((provider) => requested.has(provider.id)).slice(0, MAX_PROVIDERS);
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
