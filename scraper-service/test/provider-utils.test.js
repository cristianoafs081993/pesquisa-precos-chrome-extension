const assert = require("node:assert/strict");
const test = require("node:test");
const { providers, createCustomProvider, sanitizeProviderId } = require("../providers");
const { dedupeResults, interleaveResults, normalizeProviderResult, normalizePriceText, selectProviders } = require("../server");

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

test("only Amazon is enabled by default in the extension quality-first rollout", () => {
  const amazon = providers.find((provider) => provider.id === "amazon");
  assert.equal(amazon.requirePrice, true);
  assert.deepEqual(amazon.allowedHostnames, ["amazon.com.br"]);
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

test("price normalization only accepts Brazilian currency values", () => {
  assert.equal(normalizePriceText("por apenas R$ 1.234,5600 hoje"), "R$ 1.234,5600");
  assert.equal(normalizePriceText("sem preco disponivel"), "");
});
