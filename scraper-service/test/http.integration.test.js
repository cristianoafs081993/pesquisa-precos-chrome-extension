const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppServer } = require("../server");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("search endpoint returns normalized mocked results and provider metadata", async () => {
  const server = createAppServer({
    searchProvidersImpl: async (query, selectedProviders) => [{
      title: `Resultado para ${query}`,
      link: "https://fornecedor.example/produto",
      displayLink: "fornecedor.example",
      snippet: "R$ 100,00",
      price: "R$ 100,00",
      provider: selectedProviders[0].id
    }]
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "cadeira branca", providers: ["amazon", "kabum"] })
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].provider, "amazon");
    assert.deepEqual(data.meta.providers, ["amazon", "kabum"]);
    assert.equal(data.meta.queryPrimary, "cadeira branca");
    assert.equal(data.meta.enrichment.catalogMatch, null);
  } finally {
    await close(server);
  }
});

test("search endpoint interleaves stores after ranking", async () => {
  const server = createAppServer({
    searchProvidersImpl: async () => [
      { title: "cadeira magalu a", link: "https://magalu.example/a", price: "R$ 10,00", provider: "magalu", providerName: "Magazine Luiza" },
      { title: "cadeira magalu b", link: "https://magalu.example/b", price: "R$ 11,00", provider: "magalu", providerName: "Magazine Luiza" },
      { title: "cadeira magalu c", link: "https://magalu.example/c", price: "R$ 12,00", provider: "magalu", providerName: "Magazine Luiza" },
      { title: "cadeira amazon a", link: "https://amazon.example/a", price: "R$ 13,00", provider: "amazon", providerName: "Amazon Brasil" },
      { title: "cadeira americanas a", link: "https://americanas.example/a", price: "R$ 14,00", provider: "americanas", providerName: "Americanas" }
    ]
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "cadeira", providers: ["amazon", "magalu", "americanas"] })
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(data.results.slice(0, 5).map((item) => item.provider), [
      "amazon",
      "magalu",
      "americanas",
      "magalu",
      "magalu"
    ]);
  } finally {
    await close(server);
  }
});

test("search endpoint validates query length", async () => {
  const server = createAppServer();
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "ab" })
    });
    const data = await response.json();

    assert.equal(response.status, 400);
    assert.match(data.error, /at least 3/);
  } finally {
    await close(server);
  }
});
