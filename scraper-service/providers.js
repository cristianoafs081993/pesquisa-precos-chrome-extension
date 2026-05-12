const GENERIC_ITEM_SELECTOR = [
  "[data-testid*='product']",
  "[class*='product']",
  "[class*='card']",
  "article",
  "li"
].join(",");

const GENERIC_TITLE_SELECTOR = [
  "[data-testid*='title']",
  "[class*='title']",
  "[class*='name']",
  "h2",
  "h3",
  "a[title]"
].join(",");

const GENERIC_PRICE_SELECTOR = [
  "[data-testid*='price']",
  "[class*='price']",
  ".price",
  "span",
  "p"
].join(",");

const providers = [
  // Cada provider descreve como montar a URL de busca e quais seletores
  // capturam cards, titulo, link, preco e imagem. Quando um site mudar o HTML,
  // a manutencao normalmente deve ficar restrita a este arquivo.
  {
    id: "amazon",
    name: "Amazon Brasil",
    buildUrl: (query) => `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`,
    itemSelector: "[data-component-type='s-search-result']",
    titleSelector: "h2 span, h2 a span, .a-size-base-plus.a-color-base.a-text-normal, .a-size-medium.a-color-base.a-text-normal",
    linkSelector: "a.a-link-normal.s-no-outline[href], h2 a[href], a[href*='/dp/'], a[href*='/gp/product/']",
    priceSelector: ".a-price > .a-offscreen, .a-price .a-offscreen",
    priceWholeSelector: ".a-price .a-price-whole",
    priceFractionSelector: ".a-price .a-price-fraction",
    imageSelector: "img.s-image",
    allowedHostnames: ["amazon.com.br"],
    requirePrice: true,
    productPathPattern: /\/(dp|gp\/product)\/[A-Z0-9]{10}/i,
    normalizeLink: normalizeAmazonLink
  },
  {
    id: "magalu",
    name: "Magazine Luiza",
    buildUrl: (query) => `https://m.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`,
    requestHeaders: {
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8"
    },
    extractFromHtml: extractMagaluHtmlResults,
    itemSelector: "a[data-testid='product-card-container']",
    titleSelector: [
      "[data-testid='product-title']",
      "[data-testid='image']",
      "img[alt]",
      "p",
      "h2",
      "h3"
    ].join(","),
    linkSelector: "a[data-testid='product-card-container'][href], a[href*='/p/']",
    priceSelector: "[data-testid='price-value'], [data-testid='price-original'], p, span",
    imageSelector: "img[data-testid='image'], img",
    allowedHostnames: ["magazineluiza.com.br"],
    requirePrice: true,
    productPathPattern: /\/p\/[a-z0-9]+\/[a-z0-9]+\/[a-z0-9]+\/?/i,
    normalizeLink: normalizeMagaluLink
  },
  {
    id: "americanas",
    name: "Americanas",
    buildUrl: (query) => `https://www.americanas.com.br/busca/${encodeURIComponent(query)}`,
    itemSelector: [
      "a[ins-product-id]",
      "a[data-product-categories]"
    ].join(","),
    titleSelector: [
      "[data-testid*='product-title']",
      "[data-testid*='title']",
      "[class*='product-name']",
      "[class*='ProductName']",
      "[class*='name']",
      "[class*='title']",
      "h2",
      "h3",
      "a[title]"
    ].join(","),
    linkSelector: [
      "a[ins-product-id]",
      "a[data-product-categories]",
      "a[href*='/produto/']",
      "a[href*='/p/']",
      "a[href$='/p']",
      "a[href*='/p?']",
      "a[href]"
    ].join(","),
    priceSelector: [
      "[data-testid*='price']",
      "[class*='salesPrice']",
      "[class*='price']",
      "[class*='Price']",
      "span",
      "p"
    ].join(","),
    imageSelector: "img",
    allowedHostnames: ["americanas.com.br"],
    requirePrice: true,
    productPathPattern: /\/(?:produto\/[^/?#]+|[^/?#]+\/p)(?:[/?#]|$)/i,
    normalizeLink: normalizeAmericanasLink
  },
  {
    id: "casasbahia",
    name: "Casas Bahia",
    buildUrl: (query) => `https://www.casasbahia.com.br/${encodeURIComponent(query)}/b`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
  },
  {
    id: "kabum",
    name: "KaBuM",
    buildUrl: (query) => `https://www.kabum.com.br/busca/${encodeURIComponent(query)}`,
    itemSelector: "article, .productCard, [class*='productCard'], [data-testid*='product']",
    titleSelector: "h2, h3, [class*='name'], [class*='title']",
    linkSelector: "a[href]",
    priceSelector: "[class*='price'], .priceCard, span",
    imageSelector: "img"
  },
  {
    id: "dell",
    name: "Dell Brasil",
    buildUrl: (query) => `https://www.dell.com/pt-br/search/${encodeURIComponent(query)}`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
  },
  {
    id: "lenovo",
    name: "Lenovo Brasil",
    buildUrl: (query) => `https://www.lenovo.com/br/pt/search?text=${encodeURIComponent(query)}`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
  },
  {
    id: "maisoffice",
    name: "MaisOFFICE",
    buildUrl: (query) => `https://www.maisoffice.com.br/busca?busca=${encodeURIComponent(query)}`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
  },
  {
    id: "kalunga",
    name: "Kalunga",
    buildUrl: (query) => `https://www.kalunga.com.br/busca/${encodeURIComponent(query)}`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
  },
  {
    id: "fastshop",
    name: "Fast Shop",
    buildUrl: (query) => `https://www.fastshop.com.br/web/s/${encodeURIComponent(query)}`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
  }
];

function normalizeAmazonLink(value) {
  try {
    const url = new URL(value);
    const sponsoredTarget = url.searchParams.get("url");
    const path = sponsoredTarget ? decodeURIComponent(sponsoredTarget) : url.pathname;
    const match = path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (!match) return value;
    return `${url.origin}/dp/${match[1]}`;
  } catch {
    return value;
  }
}

function extractMagaluHtmlResults(html, pageUrl, maxResults) {
  const cardPattern = /<a\b[^>]*data-testid=["']product-card-container["'][\s\S]*?<\/a>/gi;
  const cards = String(html || "").match(cardPattern) || [];

  return cards.slice(0, maxResults * 2).map((card) => {
    const href = pickHtmlAttribute(card, "href");
    const imageTag = card.match(/<img\b[^>]*>/i)?.[0] || "";
    const title = decodeHtml(pickHtmlAttribute(imageTag, "alt")) ||
      decodeHtml(stripHtml(card.match(/<p\b[^>]*>[\s\S]*?<\/p>/i)?.[0] || ""));
    const image = pickHtmlAttribute(imageTag, "src") || pickHtmlAttribute(imageTag, "data-src");
    const priceBlock = card.match(/<(p|span|div)\b[^>]*data-testid=["']price-value["'][^>]*>[\s\S]*?<\/\1>/i)?.[0] || "";
    const price = pickFirstCurrency(decodeHtml(stripHtml(priceBlock))) ||
      pickFirstCurrency(decodeHtml(stripHtml(card)));

    return {
      title,
      link: absoluteUrl(href, pageUrl),
      displayLink: "",
      snippet: price || decodeHtml(stripHtml(card)).slice(0, 220),
      thumbnailLink: absoluteUrl(image, pageUrl),
      price,
      provider: "magalu",
      providerName: "Magazine Luiza",
      status: "ok"
    };
  }).filter((item) => item.link && item.title);
}

function pickHtmlAttribute(html, attr) {
  const match = String(html || "").match(new RegExp(`\\s${attr}=(["'])(.*?)\\1`, "i"));
  return match ? decodeHtml(match[2]) : "";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function pickFirstCurrency(value) {
  const match = String(value || "").match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2,4})?|R\$\s*\d+(?:,\d{2,4})?/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function normalizeMagaluLink(value) {
  try {
    const url = new URL(value);
    url.protocol = "https:";
    url.hostname = "www.magazineluiza.com.br";
    url.hash = "";

    for (const key of Array.from(url.searchParams.keys())) {
      if (!/^(seller_id|partner_id)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return value;
  }
}

function normalizeAmericanasLink(value) {
  try {
    const url = new URL(value);
    url.hash = "";

    for (const key of Array.from(url.searchParams.keys())) {
      if (!/^chave|^correlation|^pfm|^opn|^seller|^condition$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return value;
  }
}

function createCustomProvider(source) {
  const id = sanitizeProviderId(source.id || source.name || source.searchUrlTemplate || "custom");
  const template = String(source.searchUrlTemplate || source.urlTemplate || "").trim();
  if (!template || !template.includes("{query}")) {
    return null;
  }

  return {
    id,
    name: String(source.name || id).trim(),
    custom: true,
    buildUrl: (query) => template.replace(/\{query\}/g, encodeURIComponent(query)),
    itemSelector: source.itemSelector || GENERIC_ITEM_SELECTOR,
    titleSelector: source.titleSelector || GENERIC_TITLE_SELECTOR,
    linkSelector: source.linkSelector || "a[href]",
    priceSelector: source.priceSelector || GENERIC_PRICE_SELECTOR,
    imageSelector: source.imageSelector || "img"
  };
}

function sanitizeProviderId(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "custom";
}

module.exports = {
  providers,
  createCustomProvider,
  sanitizeProviderId,
  normalizeAmazonLink,
  normalizeMagaluLink,
  normalizeAmericanasLink,
  GENERIC_ITEM_SELECTOR,
  GENERIC_TITLE_SELECTOR,
  GENERIC_PRICE_SELECTOR
};
