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
    buildUrl: (query) => `https://www.magazineluiza.com.br/busca/${encodeURIComponent(query)}/`,
    itemSelector: "[data-testid='product-card'], li, article",
    titleSelector: "[data-testid='product-title'], h2, h3, a[title]",
    linkSelector: "a[href]",
    priceSelector: "[data-testid='price-value'], [data-testid='price-original'], p, span",
    imageSelector: "img"
  },
  {
    id: "americanas",
    name: "Americanas",
    buildUrl: (query) => `https://www.americanas.com.br/busca/${encodeURIComponent(query)}`,
    itemSelector: GENERIC_ITEM_SELECTOR,
    titleSelector: GENERIC_TITLE_SELECTOR,
    linkSelector: "a[href]",
    priceSelector: GENERIC_PRICE_SELECTOR,
    imageSelector: "img"
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
  GENERIC_ITEM_SELECTOR,
  GENERIC_TITLE_SELECTOR,
  GENERIC_PRICE_SELECTOR
};
