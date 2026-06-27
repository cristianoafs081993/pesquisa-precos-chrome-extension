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

    if (request.method === "POST" && request.url === "/capture") {
      if (TOKEN && getToken(request) !== TOKEN) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const body = await readJson(request);
      const url = String(body.url || "").trim();
      const cep = normalizeFreightZip(String(body.cep || "").trim());

      if (!url) {
        sendJson(response, 400, { error: "URL is required" });
        return;
      }

      const startedAt = Date.now();
      const browser = await getBrowser();
      const context = await browser.newContext({
        locale: "pt-BR",
        timezoneId: "America/Sao_Paulo",
        viewport: { width: 1280, height: 800 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
      });

      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(2500);

        // Captura frete automaticamente para Amazon com CEP
        let freight = { status: "pending", total: null, cep: cep || "", text: "Fornecedor sem captura automatica de frete." };
        if (cep && isAmazonUrl(url)) {
          try {
            freight = await extractAmazonFreightPlaywright(page, cep);
          } catch (freightErr) {
            freight = { status: "pending", total: null, cep, text: String(freightErr.message || "Falha ao capturar frete.") };
          }
        } else if (!cep && isAmazonUrl(url)) {
          freight = { status: "pending", total: null, cep: "", text: "CEP nao configurado." };
        }

        // Aguarda um pouco mais para a página estabilizar antes do screenshot
        await page.waitForTimeout(1000);
        const screenshotBuffer = await page.screenshot({ type: "png", fullPage: false });
        const base64 = `data:image/png;base64,${screenshotBuffer.toString("base64")}`;
        sendJson(response, 200, {
          screenshot: base64,
          freight,
          meta: {
            url,
            cep: cep || null,
            elapsedMs: Date.now() - startedAt
          }
        });
      } finally {
        await page.close();
        await context.close();
      }
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
    const diversifiedResults = interleaveResultsByProvider(rankedResults, selectedProviders.map((provider) => provider.id));

    sendJson(response, 200, {
      results: diversifiedResults.slice(0, MAX_RESULTS),
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
  const url = provider.buildUrl(query);
  if (typeof provider.extractFromHtml === "function") {
    const response = await fetch(url, {
      headers: provider.requestHeaders || {}
    });
    if (!response.ok) {
      throw new Error(`Busca falhou (${response.status}) em ${provider.name}`);
    }

    const html = await response.text();
    return provider.extractFromHtml(html, url, MAX_RESULTS_PER_PROVIDER)
      .map((item) => normalizeProviderResult(item, provider))
      .filter(Boolean);
  }

  const page = await context.newPage();

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
    const elements = [
      root.matches?.(selector) ? root : null,
      ...Array.from(root.querySelectorAll(selector))
    ].filter(Boolean);
    const element = elements.find((candidate) => candidate.textContent && candidate.textContent.trim());
    return element ? element.textContent.trim().replace(/\s+/g, " ") : "";
  };

  const pickAttr = (root, selector, attr) => {
    if (!selector) return "";
    const elements = [
      root.matches?.(selector) ? root : null,
      ...Array.from(root.querySelectorAll(selector))
    ].filter(Boolean);
    const element = elements.find((candidate) => candidate.getAttribute(attr));
    return element ? element.getAttribute(attr) : "";
  };

  const pickAnyAttr = (root, selector, attrs) => {
    for (const attr of attrs) {
      const value = pickAttr(root, selector, attr);
      if (value) return value;
    }
    return "";
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
    const priceElements = [
      root.matches?.(config.priceSelector) ? root : null,
      ...Array.from(root.querySelectorAll(config.priceSelector || ""))
    ].filter(Boolean);
    for (const element of priceElements) {
      const candidate = normalizePrice(element.textContent || "");
      if (candidate) return candidate;
    }
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
    const image = toAbsoluteUrl(pickAnyAttr(node, config.imageSelector, ["src", "data-src", "data-lazy", "data-original", "srcset"]).split(/\s+/)[0]);
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

function interleaveResultsByProvider(results, providerOrder = []) {
  if (!Array.isArray(results) || !results.length) {
    return [];
  }

  const groups = new Map();
  for (const result of results) {
    const providerId = result?.provider || "unknown";
    if (!groups.has(providerId)) {
      groups.set(providerId, []);
    }
    groups.get(providerId).push(result);
  }

  const orderedProviderIds = [
    ...providerOrder.filter((providerId) => groups.has(providerId)),
    ...Array.from(groups.keys()).filter((providerId) => !providerOrder.includes(providerId))
  ];

  return interleaveResults(orderedProviderIds.map((providerId) => groups.get(providerId)));
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

// ── Freight helpers (portado do background.js da extensão) ──────────────────

function normalizeFreightZip(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 8 ? digits : "";
}

function isAmazonUrl(url) {
  try {
    return /amazon\.com\.br/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function normalizeFreightResult(result, cep) {
  if (result?.status === "free") {
    return { status: "free", total: 0, cep, text: result.text || "Frete gratis" };
  }
  if (result?.status === "captured" && Number.isFinite(Number(result.total))) {
    return { status: "captured", total: Number(result.total), cep, text: result.text || "" };
  }
  return { status: "pending", total: null, cep, text: result?.text || "Frete nao encontrado automaticamente." };
}

/**
 * Extrai o frete da Amazon usando Playwright (page.evaluate).
 * Porta fielmente a função extractAmazonFreight do background.js da extensão Chrome.
 */
async function extractAmazonFreightPlaywright(page, cep) {
  const zipDigits = String(cep || "").replace(/\D/g, "");
  if (zipDigits.length !== 8) {
    return { status: "pending", total: null, cep, text: "CEP invalido." };
  }

  // Injeta e executa a lógica de frete dentro do contexto da página
  const result = await page.evaluate(async (zipDigits) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const formattedZip = `${zipDigits.slice(0, 5)}-${zipDigits.slice(5)}`;
    const normalizeText = (v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
    const textOf = (el) => String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const clickFirst = (selectors) => {
      const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
      if (el) { el.click(); return true; }
      return false;
    };
    const setInputValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const parseCurrencyValue = (value) => {
      const match = String(value || "").match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2})/i);
      if (!match) return null;
      const number = Number(match[0].replace(/[^\d,]/g, "").replace(",", "."));
      return Number.isFinite(number) ? number : null;
    };
    const parseFreightCurrency = (value) => {
      const text = String(value || "");
      const m1 = text.match(/(?:frete|entrega|envio)[^R$]{0,80}(R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2}))/i);
      if (m1) return parseCurrencyValue(m1[1]);
      const m2 = text.match(/(R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2}))[^R$]{0,80}(?:frete|entrega|envio)/i);
      if (m2) return parseCurrencyValue(m2[1]);
      return null;
    };
    const pageZipMatches = () => {
      const locationText = [
        "#nav-global-location-popover-link",
        "#contextualIngressPtLabel_deliveryShortLine",
        "#glow-ingress-line1",
        "#glow-ingress-line2"
      ].map((s) => textOf(document.querySelector(s))).join(" ");
      return locationText.replace(/\D/g, "").includes(zipDigits);
    };
    const fillCepInputs = () => {
      const firstPart = document.querySelector("#GLUXZipUpdateInput_0");
      const secondPart = document.querySelector("#GLUXZipUpdateInput_1");
      if (firstPart && secondPart) {
        setInputValue(firstPart, zipDigits.slice(0, 5));
        setInputValue(secondPart, zipDigits.slice(5));
        return true;
      }
      const singleInput = document.querySelector("#GLUXZipUpdateInput, input[name='zipCode'], input[autocomplete='postal-code']");
      if (singleInput) { setInputValue(singleInput, formattedZip); return true; }
      return false;
    };
    const applyCepWithGlowApi = async () => {
      const csrfToken = document.querySelector(".GLUX_Popover meta[name='anti-csrftoken-a2z']")?.content ||
        document.querySelector("meta[name='anti-csrftoken-a2z']")?.content ||
        document.querySelector("#glowValidationToken")?.value || "";
      try {
        const res = await fetch("/portal-migration/hz/glow/address-change?actionSource=glow", {
          method: "POST", credentials: "include",
          headers: { "accept": "text/html,*/*", "anti-csrftoken-a2z": csrfToken, "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: JSON.stringify({ locationType: "LOCATION_INPUT", zipCode: formattedZip, deviceType: "web", storeContext: "home", pageType: "Detail", actionSource: "glow" })
        });
        if (!res.ok) return false;
        const text = await res.text();
        if (!text) return true;
        try { const d = JSON.parse(text); return d?.isAddressUpdated === 1 || d?.successful === 1 || d?.isValidAddress === 1; } catch { return true; }
      } catch { return false; }
    };
    const findFreightText = () => {
      const prioritySelectors = [
        "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
        "#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE",
        "#deliveryBlockMessage", "#deliveryBlock_feature_div",
        "#contextualIngressPtLabel_deliveryShortLine", "#rightCol", "#buybox"
      ];
      const nodes = [...prioritySelectors.flatMap((s) => Array.from(document.querySelectorAll(s))), ...Array.from(document.querySelectorAll("span, div, p, li"))];
      const seen = new Set();
      const candidates = nodes.map(textOf).filter(Boolean).filter((text) => {
        const key = normalizeText(text).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return /(frete|entrega|envio|gratis)/i.test(key) && !/prime video|ofertas exclusivas|aproveite|teste gratis|assinatura|audible/i.test(key);
      }).slice(0, 120).map((text) => ({ text, normalized: normalizeText(text).toLowerCase() }));
      for (const candidate of candidates) {
        if (/(?:frete|entrega|envio).{0,40}gratis|gratis.{0,40}(?:frete|entrega|envio)/i.test(candidate.normalized)) {
          return { status: "free", total: 0, text: candidate.text };
        }
        if (/(frete|entrega|envio)/i.test(candidate.normalized)) {
          const total = parseFreightCurrency(candidate.text);
          if (total !== null) return { status: "captured", total, text: candidate.text };
        }
      }
      return { status: "pending", total: null, text: candidates[0]?.text || "" };
    };

    if (pageZipMatches()) {
      const already = findFreightText();
      if (already.status !== "pending") return already;
    }

    clickFirst(["#nav-global-location-popover-link", "#contextualIngressPtLabel_deliveryShortLine", "#glow-ingress-block", "[data-action='GLUXAddressBlockAction']"]);
    await sleep(1200);

    if (fillCepInputs()) {
      await sleep(200);
      clickFirst(["input[aria-labelledby='GLUXZipUpdate-announce']", "#GLUXZipUpdate", "span#GLUXZipUpdate input", "button[name='glowDoneButton']"]);
      await sleep(2500);
      clickFirst(["button[name='glowDoneButton']", "#GLUXConfirmClose", ".a-popover-footer button", "input[data-action-type='SELECT_LOCATION']"]);
      await sleep(1200);
    } else {
      await applyCepWithGlowApi();
      await sleep(2500);
    }

    const captured = findFreightText();
    if (captured.status !== "pending" && pageZipMatches()) return captured;
    return {
      status: "pending", total: null,
      text: pageZipMatches()
        ? captured.text || "Frete nao encontrado no bloco de entrega da Amazon."
        : `CEP ${formattedZip} nao foi aplicado pela Amazon antes da leitura do frete.`
    };
  }, zipDigits);

  return normalizeFreightResult(result, cep);
}

// ───────────────────────────────────────────────────────────────────────────

module.exports = {
  createAppServer,
  searchProviders,
  scrapeProvider,
  normalizeProviderResult,
  normalizeProviderLink,
  normalizePriceText,
  selectProviders,
  interleaveResults,
  interleaveResultsByProvider,
  dedupeResults,
  normalizeUrl,
  hostname,
  enrichSearchContext,
  rerankResultsWithCatalog
};
