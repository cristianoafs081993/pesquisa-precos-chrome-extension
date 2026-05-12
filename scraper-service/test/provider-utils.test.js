const assert = require("node:assert/strict");
const test = require("node:test");
const { providers, createCustomProvider, sanitizeProviderId } = require("../providers");
const { dedupeResults, interleaveResults, interleaveResultsByProvider, normalizeProviderResult, normalizePriceText, selectProviders } = require("../server");

test("default providers use expected priority order and exclude Mercado Livre", () => {
  assert.equal(providers.length, 10);
  assert.deepEqual(providers.slice(0, 8).map((provider) => provider.id), [
    "amazon",
    "magalu",
    "americanas",
    "casasbahia",
    "kabum",
    "dell",
    "lenovo",
    "maisoffice"
  ]);
  assert.ok(!providers.some((provider) => /mercado\s*livre/i.test(provider.name)));
});

test("Amazon, Magalu and Americanas use stricter provider normalization", () => {
  const amazon = providers.find((provider) => provider.id === "amazon");
  const magalu = providers.find((provider) => provider.id === "magalu");
  const americanas = providers.find((provider) => provider.id === "americanas");

  assert.equal(amazon.requirePrice, true);
  assert.deepEqual(amazon.allowedHostnames, ["amazon.com.br"]);
  assert.equal(magalu.requirePrice, true);
  assert.deepEqual(magalu.allowedHostnames, ["magazineluiza.com.br"]);
  assert.ok(magalu.productPathPattern.test("/cadeira-de-escritorio/p/fh38j68b56/mo/moec/"));
  assert.equal(typeof magalu.extractFromHtml, "function");
  assert.equal(americanas.requirePrice, true);
  assert.deepEqual(americanas.allowedHostnames, ["americanas.com.br"]);
  assert.ok(americanas.productPathPattern.test("/produto/123"));
  assert.ok(americanas.productPathPattern.test("/cadeira-de-escritorio-123/p"));
});

test("selectProviders preserves requested order and accepts custom sources", () => {
  const selected = selectProviders([
    "kabum",
    {
      id: "Fornecedor Local",
      name: "Fornecedor Local",
      searchUrlTemplate: "https://local.example/busca?q={query}"
    },
    "amazon"
  ]);

  assert.deepEqual(selected.map((provider) => provider.id), ["kabum", "fornecedor-local", "amazon"]);
  assert.equal(selected[1].buildUrl("mesa teste"), "https://local.example/busca?q=mesa%20teste");
});

test("custom providers require query placeholder", () => {
  assert.equal(createCustomProvider({ name: "Sem placeholder", searchUrlTemplate: "https://example.com" }), null);
  assert.equal(sanitizeProviderId("Mais OFFICE / Natal"), "mais-office-natal");
});

test("dedupe and interleave keep result diversity", () => {
  const interleaved = interleaveResults([
    [{ link: "https://a.example/1" }, { link: "https://a.example/2" }],
    [{ link: "https://b.example/1" }]
  ]);
  assert.deepEqual(interleaved.map((item) => item.link), [
    "https://a.example/1",
    "https://b.example/1",
    "https://a.example/2"
  ]);

  const deduped = dedupeResults([
    { link: "https://a.example/1#x" },
    { link: "https://a.example/1" },
    { link: "https://b.example/1" }
  ]);
  assert.deepEqual(deduped.map((item) => item.link), ["https://a.example/1#x", "https://b.example/1"]);
});

test("provider interleave restores store diversity after ranking", () => {
  const ranked = [
    { provider: "magalu", link: "https://magalu.example/1" },
    { provider: "magalu", link: "https://magalu.example/2" },
    { provider: "magalu", link: "https://magalu.example/3" },
    { provider: "amazon", link: "https://amazon.example/1" },
    { provider: "amazon", link: "https://amazon.example/2" },
    { provider: "americanas", link: "https://americanas.example/1" }
  ];

  assert.deepEqual(
    interleaveResultsByProvider(ranked, ["amazon", "magalu", "americanas"]).map((item) => item.link),
    [
      "https://amazon.example/1",
      "https://magalu.example/1",
      "https://americanas.example/1",
      "https://amazon.example/2",
      "https://magalu.example/2",
      "https://magalu.example/3"
    ]
  );
});

test("provider normalization rejects technical noise and keeps priced Amazon products", () => {
  const amazon = providers.find((provider) => provider.id === "amazon");

  const accepted = normalizeProviderResult({
    title: "Patrocinado Cadeira empilhavel branca",
    link: "https://www.amazon.com.br/Cadeira-Teste/dp/B0ABCDEF12/ref=sr_1_1",
    price: "R$ 559,00"
  }, amazon);

  assert.equal(accepted.title, "Cadeira empilhavel branca");
  assert.equal(accepted.link, "https://www.amazon.com.br/dp/B0ABCDEF12");
  assert.equal(accepted.displayLink, "amazon.com.br");
  assert.equal(accepted.price, "R$ 559,00");

  assert.equal(normalizeProviderResult({
    title: "Conheca Lenovo Pro",
    link: "https://www.amazon.com.br/Cadeira-Teste/dp/B0ABCDEF12/ref=sr_1_1",
    price: ""
  }, amazon), null);

  assert.equal(normalizeProviderResult({
    title: "Produto fora do dominio",
    link: "https://example.com/produto/dp/B0ABCDEF12",
    price: "R$ 10,00"
  }, amazon), null);

  const sponsored = normalizeProviderResult({
    title: "Cadeira patrocinada",
    link: "https://www.amazon.com.br/sspa/click?url=%2FProduto-Teste%2Fdp%2FB0ZYXWVU98%2Fref%3Dsr_1_1_sspa",
    price: "R$ 202,00"
  }, amazon);
  assert.equal(sponsored.link, "https://www.amazon.com.br/dp/B0ZYXWVU98");
});

test("provider normalization keeps priced Magalu products", () => {
  const magalu = providers.find((provider) => provider.id === "magalu");

  const accepted = normalizeProviderResult({
    title: "Cadeira de escritorio diretor",
    link: "https://m.magazineluiza.com.br/cadeira-de-escritorio-diretor/p/fh38j68b56/mo/moec/?ads=patrocinado&seller_id=oficialwebshop",
    price: "R$ 234,99"
  }, magalu);

  assert.equal(accepted.title, "Cadeira de escritorio diretor");
  assert.equal(accepted.link, "https://www.magazineluiza.com.br/cadeira-de-escritorio-diretor/p/fh38j68b56/mo/moec/?seller_id=oficialwebshop");
  assert.equal(accepted.displayLink, "magazineluiza.com.br");
  assert.equal(accepted.price, "R$ 234,99");

  assert.equal(normalizeProviderResult({
    title: "Categoria de cadeiras",
    link: "https://www.magazineluiza.com.br/moveis/cadeira/l/mo/cade/",
    price: "R$ 10,00"
  }, magalu), null);

  assert.equal(normalizeProviderResult({
    title: "Produto sem preco",
    link: "https://www.magazineluiza.com.br/cadeira-de-escritorio/p/fh38j68b56/mo/moec/",
    price: ""
  }, magalu), null);
});

test("Magalu HTML extraction reads product cards and primary price", () => {
  const magalu = providers.find((provider) => provider.id === "magalu");
  const html = `
    <a href="/cadeira-de-escritorio/p/fh38j68b56/mo/moec/?ads=patrocinado&seller_id=oficialwebshop" data-testid="product-card-container">
      <img data-testid="image" alt="Cadeira de Escritório Diretor" src="https://a-static.mlcdn.com.br/186x136/cadeira.jpg">
      <p>Cadeira de Escritório Diretor</p>
      <p data-testid="installment">4x de R$ 73,44 sem juros</p>
      <p data-testid="price-value"><span>ou </span>R$ 234,99</p>
    </a>
  `;

  const [item] = magalu.extractFromHtml(html, "https://m.magazineluiza.com.br/busca/cadeira/", 5);
  assert.equal(item.title, "Cadeira de Escritório Diretor");
  assert.equal(item.price, "R$ 234,99");
  assert.equal(item.link, "https://m.magazineluiza.com.br/cadeira-de-escritorio/p/fh38j68b56/mo/moec/?ads=patrocinado&seller_id=oficialwebshop");
  assert.equal(item.thumbnailLink, "https://a-static.mlcdn.com.br/186x136/cadeira.jpg");
});

test("provider normalization keeps priced Americanas products", () => {
  const americanas = providers.find((provider) => provider.id === "americanas");

  const accepted = normalizeProviderResult({
    title: "Cadeira de escritorio preta",
    link: "https://www.americanas.com.br/produto/1234567890/cadeira-de-escritorio?pfm_carac=busca&chave=search",
    price: "R$ 329,90"
  }, americanas);

  assert.equal(accepted.title, "Cadeira de escritorio preta");
  assert.equal(accepted.link, "https://www.americanas.com.br/produto/1234567890/cadeira-de-escritorio?pfm_carac=busca&chave=search");
  assert.equal(accepted.displayLink, "americanas.com.br");
  assert.equal(accepted.price, "R$ 329,90");

  assert.equal(normalizeProviderResult({
    title: "Link institucional",
    link: "https://www.americanas.com.br/hotsite/app",
    price: "R$ 10,00"
  }, americanas), null);

  assert.equal(normalizeProviderResult({
    title: "Produto sem preco",
    link: "https://www.americanas.com.br/produto/1234567890/cadeira",
    price: ""
  }, americanas), null);
});

test("price normalization only accepts Brazilian currency values", () => {
  assert.equal(normalizePriceText("por apenas R$ 1.234,5600 hoje"), "R$ 1.234,5600");
  assert.equal(normalizePriceText("sem preco disponivel"), "");
});
