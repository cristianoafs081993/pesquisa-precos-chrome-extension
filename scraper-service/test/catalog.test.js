const assert = require("node:assert/strict");
const test = require("node:test");
const {
  enrichSearchContext,
  rerankResultsWithCatalog,
  extractCatalogCode
} = require("../catalog");

const catalogIndex = {
  "631951": {
    codigoItem: "631951",
    descricaoItem: "Mesa para computador em MDF com gavetas",
    nomePdm: "Mesa para computador",
    nomeClasse: "Mobiliario de escritorio",
    nomeGrupo: "Moveis",
    codigoNcm: "94033000",
    searchText: "mesa computador mdf gaveta"
  }
};

test("extractCatalogCode reads CATMAT from the beginning of the description", () => {
  assert.equal(extractCatalogCode("631951 - Mesa Material: Mdp"), "631951");
  assert.equal(extractCatalogCode("Mesa Material: Mdp"), "");
});

test("enrichSearchContext upgrades the query when CATMAT exists in the catalog", () => {
  const enrichment = enrichSearchContext({
    query: "mesa para computador",
    itemContext: {
      description: "631951 - Mesa Material: Mdp",
      originalDescription: "631951 - Mesa Material: Mdp",
      catalogCode: "631951"
    },
    catalogIndex
  });

  assert.equal(enrichment.catalogMatch.codigoItem, "631951");
  assert.equal(enrichment.canonicalDescription, "Mesa para computador em MDF com gavetas");
  assert.match(enrichment.queryPrimary, /mesa/);
  assert.match(enrichment.queryPrimary, /computador/);
  assert.equal(enrichment.querySignals.pdm, "Mesa para computador");
  assert.equal(enrichment.querySignals.ncm, "94033000");
});

test("enrichSearchContext falls back cleanly when CATMAT is absent from the catalog", () => {
  const enrichment = enrichSearchContext({
    query: "cadeira fixa",
    itemContext: {
      description: "999999 - Cadeira fixa",
      originalDescription: "999999 - Cadeira fixa",
      catalogCode: "999999"
    },
    catalogIndex
  });

  assert.equal(enrichment.catalogMatch, null);
  assert.equal(enrichment.canonicalDescription, "999999 - Cadeira fixa");
  assert.equal(enrichment.queryPrimary, "cadeira fixa");
  assert.equal(enrichment.querySignals.catalogCode, "999999");
  assert.equal(enrichment.querySignals.ncm, "");
});

test("rerankResultsWithCatalog prioritizes results aligned with catalog semantics", () => {
  const enrichment = enrichSearchContext({
    query: "mesa para computador",
    itemContext: {
      description: "631951 - Mesa Material: Mdp",
      originalDescription: "631951 - Mesa Material: Mdp",
      catalogCode: "631951"
    },
    catalogIndex
  });

  const ranked = rerankResultsWithCatalog([
    {
      title: "Cadeira de escritorio ergonomica",
      snippet: "R$ 337,25 - Amazon Brasil",
      displayLink: "amazon.com.br",
      providerName: "Amazon Brasil"
    },
    {
      title: "Mesa para computador em MDF com gavetas 94033000",
      snippet: "R$ 899,90 - Loja Example",
      displayLink: "loja.example",
      providerName: "Loja Example"
    }
  ], enrichment);

  assert.match(ranked[0].title, /Mesa para computador/i);
  assert.match(ranked[1].title, /Cadeira de escritorio/i);
});
