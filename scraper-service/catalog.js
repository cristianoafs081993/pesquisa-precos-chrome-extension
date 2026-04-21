const fs = require("node:fs");
const path = require("node:path");

const CATALOG_INDEX_PATH = path.resolve(__dirname, "..", "catalog", "catalog-index.json");
const STOPWORDS = new Set([
  "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e", "em",
  "na", "nas", "no", "nos", "o", "os", "ou", "para", "por", "um", "uma"
]);

let catalogCache;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function singularizeToken(token) {
  if (token.length <= 4 || !token.endsWith("s")) {
    return token;
  }

  return token.slice(0, -1);
}

function tokenizeText(value) {
  const seen = new Set();
  const tokens = [];

  normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .forEach((token) => {
      const singular = singularizeToken(token);
      if (singular.length < 3 || STOPWORDS.has(singular) || /^\d+$/.test(singular) || seen.has(singular)) {
        return;
      }

      seen.add(singular);
      tokens.push(singular);
    });

  return tokens;
}

function loadCatalogIndex() {
  if (catalogCache !== undefined) {
    return catalogCache;
  }

  try {
    const content = fs.readFileSync(CATALOG_INDEX_PATH, "utf8");
    const parsed = JSON.parse(content);
    catalogCache = parsed?.items || {};
  } catch {
    catalogCache = {};
  }

  return catalogCache;
}

function lookupCatalogEntry(codigoItem, index = loadCatalogIndex()) {
  if (!codigoItem) {
    return null;
  }

  return index[String(codigoItem).trim()] || null;
}

function extractCatalogCode(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{5,7})(?:\s*[-–—:/]\s*|\s+)/);
  return match ? match[1] : "";
}

function trimQuery(value, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function buildQueryPrimary(userQuery, catalogEntry) {
  const tokens = [];
  const seen = new Set();

  const appendTokens = (value) => {
    tokenizeText(value).forEach((token) => {
      if (!seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    });
  };

  appendTokens(userQuery);
  appendTokens(catalogEntry?.nomePdm);
  appendTokens(catalogEntry?.searchText);
  appendTokens(catalogEntry?.descricaoItem);

  return trimQuery(tokens.join(" "));
}

function enrichSearchContext({ query, itemContext = {}, catalogIndex = loadCatalogIndex() }) {
  const originalDescription = String(
    itemContext.originalDescription ||
    itemContext.description ||
    ""
  ).trim();
  const catalogCode = String(
    itemContext.catalogCode ||
    extractCatalogCode(originalDescription)
  ).trim();
  const catalogEntry = lookupCatalogEntry(catalogCode, catalogIndex);

  if (!catalogEntry) {
    return {
      originalDescription,
      catalogMatch: null,
      canonicalDescription: originalDescription || String(query || "").trim(),
      queryPrimary: trimQuery(query),
      querySignals: {
        catalogCode,
        pdm: "",
        classe: "",
        grupo: "",
        ncm: ""
      }
    };
  }

  const queryPrimary = buildQueryPrimary(query, catalogEntry);

  return {
    originalDescription,
    catalogMatch: {
      codigoItem: catalogEntry.codigoItem,
      nomePdm: catalogEntry.nomePdm,
      nomeClasse: catalogEntry.nomeClasse,
      nomeGrupo: catalogEntry.nomeGrupo,
      codigoNcm: catalogEntry.codigoNcm
    },
    canonicalDescription: catalogEntry.descricaoItem,
    queryPrimary,
    querySignals: {
      catalogCode: catalogEntry.codigoItem,
      pdm: catalogEntry.nomePdm,
      classe: catalogEntry.nomeClasse,
      grupo: catalogEntry.nomeGrupo,
      ncm: catalogEntry.codigoNcm
    }
  };
}

function scoreCatalogResult(result, enrichment) {
  if (!result || !enrichment) {
    return 0;
  }

  const text = normalizeText([
    result.title,
    result.snippet,
    result.displayLink,
    result.providerName
  ].join(" "));

  const scoreTokens = (value, weight) => {
    return tokenizeText(value).reduce((sum, token) => {
      return sum + (text.includes(token) ? weight : 0);
    }, 0);
  };

  let score = 0;
  score += scoreTokens(enrichment.queryPrimary, 5);
  score += scoreTokens(enrichment.querySignals?.pdm, 6);
  score += scoreTokens(enrichment.canonicalDescription, 3);
  score += scoreTokens(enrichment.querySignals?.classe, 2);
  score += scoreTokens(enrichment.querySignals?.grupo, 1);

  if (enrichment.querySignals?.ncm && text.includes(String(enrichment.querySignals.ncm))) {
    score += 8;
  }

  return score;
}

function rerankResultsWithCatalog(results, enrichment) {
  if (!Array.isArray(results) || !results.length) {
    return [];
  }

  return [...results].sort((left, right) => {
    const scoreDiff = scoreCatalogResult(right, enrichment) - scoreCatalogResult(left, enrichment);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return String(left.title || "").localeCompare(String(right.title || ""), "pt-BR");
  });
}

module.exports = {
  CATALOG_INDEX_PATH,
  loadCatalogIndex,
  lookupCatalogEntry,
  extractCatalogCode,
  enrichSearchContext,
  scoreCatalogResult,
  rerankResultsWithCatalog,
  tokenizeText
};
