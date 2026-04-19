const providers = [
  // Cada provider descreve como montar a URL de busca e quais seletores
  // capturam cards, titulo, link, preco e imagem. Quando um site mudar o HTML,
  // a manutencao normalmente deve ficar restrita a este arquivo.
  {
    id: "mercadolivre",
    name: "Mercado Livre",
    buildUrl: (query) => `https://lista.mercadolivre.com.br/${encodeURIComponent(query).replace(/%20/g, "-")}`,
    itemSelector: ".ui-search-result, .ui-search-result__wrapper, li.ui-search-layout__item",
    titleSelector: ".poly-component__title, .ui-search-item__title, h2, a[title]",
    linkSelector: "a[href]",
    priceSelector: ".andes-money-amount__fraction, .price-tag-fraction",
    centsSelector: ".andes-money-amount__cents, .price-tag-cents",
    imageSelector: "img"
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
    id: "amazon",
    name: "Amazon Brasil",
    buildUrl: (query) => `https://www.amazon.com.br/s?k=${encodeURIComponent(query)}`,
    itemSelector: "[data-component-type='s-search-result']",
    titleSelector: "h2 span, h2 a span",
    linkSelector: "h2 a[href], a[href]",
    priceSelector: ".a-price .a-offscreen",
    imageSelector: "img.s-image"
  }
];

module.exports = { providers };
