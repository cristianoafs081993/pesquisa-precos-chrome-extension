const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function read(filePath) {
  return fs.readFileSync(path.join(repoRoot, filePath), "utf8");
}

test("manifest keeps required extension surfaces", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.match(JSON.stringify(manifest.content_scripts), /pesqpreco\.estaleiro\.serpro\.gov\.br/);
});

test("market workflow hooks remain wired in content script", () => {
  const content = read("content.js");
  assert.match(content, /DEFAULT_MARKET_SOURCES/);
  assert.match(content, /renderMarketSourcesConfig/);
  assert.match(content, /queueMarketPrefetch/);
  assert.match(content, /buildMarketProviderPayload/);
  assert.match(content, /filterRenderableMarketResults/);
  assert.match(content, /data-pp-sources/);
  assert.doesNotMatch(content, /Backend de busca/);
  assert.doesNotMatch(content, /Token do backend/);
  assert.doesNotMatch(content, /mercadolivre/i);
});

test("floating panel separates adjustment and market workflows in tabs", () => {
  const content = read("content.js");
  assert.match(content, /data-pp-tab="adjust"/);
  assert.match(content, /data-pp-tab="market"/);
  assert.match(content, /data-pp-tab-panel="adjust"/);
  assert.match(content, /data-pp-tab-panel="market"/);
  assert.match(content, /selectFloatingTab\(panel, "market"\)/);
});

test("market session screens provide back navigation and session reset", () => {
  const content = read("content.js");
  assert.match(content, /data-pp-reset-session/);
  assert.match(content, /function renderCurrentMarketView/);
  assert.match(content, /function renderMarketHome/);
  assert.match(content, /data-pp-market-back/);
  assert.match(content, /data-pp-reset-session-view/);
  assert.match(content, /async function resetMarketSession/);
  assert.match(content, /delete data\.marketSessions\[session\.sessionId\]/);
  assert.match(content, /delete data\.marketScreenshots\[screenshotId\]/);
});

test("floating panel close button keeps a centered fixed-size hit target", () => {
  const content = read("content.js");
  assert.match(content, /\.pp-floating-header button \{[\s\S]*?display: inline-flex/);
  assert.match(content, /\.pp-floating-header button \{[\s\S]*?align-items: center/);
  assert.match(content, /\.pp-floating-header button \{[\s\S]*?justify-content: center/);
  assert.match(content, /\.pp-floating-header button \{[\s\S]*?box-sizing: border-box/);
  assert.match(content, /\.pp-floating-header button \{[\s\S]*?padding: 0/);
  assert.match(content, /\.pp-floating-header button \{[\s\S]*?line-height: 1/);
});

test("market results stay paginated and use clearer action labels", () => {
  const content = read("content.js");
  assert.match(content, /MARKET_INITIAL_RESULT_COUNT = 3/);
  assert.match(content, /MARKET_RESULT_CACHE_VERSION = 4/);
  assert.match(content, /data-pp-load-more-results/);
  assert.match(content, /Carregar mais resultados/);
  assert.match(content, /Usar no relatório/);
  assert.match(content, /data-pp-use-result/);
  assert.match(content, /captureAndAcceptMarketResult/);
  assert.match(content, /needsMarketResultRefresh/);
  assert.match(content, /Exportar sessão/);
  assert.match(content, /Importar sessão/);
  assert.match(content, /isMarketResultRelevant/);
  assert.doesNotMatch(content, /max-height: 52vh/);
  assert.doesNotMatch(content, /data-pp-market-export>Exportar JSON/);
  assert.doesNotMatch(content, /data-pp-capture-result/);
  assert.doesNotMatch(content, /data-pp-accept-result/);
});

test("content script sends CATMAT context and stores enrichment signals", () => {
  const content = read("content.js");
  assert.match(content, /function extractCatalogCodeFromDescription/);
  assert.match(content, /function stripLeadingCatalogCode/);
  assert.match(content, /itemContext:\s*\{/);
  assert.match(content, /catalogCode:\s*item\.catalogCode \|\| extractCatalogCodeFromDescription\(item\.descricao\)/);
  assert.match(content, /queryPrimary = response\.enrichment\?\.queryPrimary \|\| query/);
  assert.match(content, /querySignals = response\.enrichment\?\.querySignals \|\| \{\}/);
  assert.match(content, /canonicalDescription = response\.enrichment\?\.canonicalDescription \|\|/);
});

test("accepted quotes store validated evidence URL metadata", () => {
  const content = read("content.js");
  assert.match(content, /screenshotUrl: response\.capturedUrl \|\| result\.link/);
  assert.match(content, /screenshotRequestedUrl: response\.requestedUrl \|\| result\.link/);
  assert.match(content, /openedTabId: response\.openedTabId \|\| null/);
});

test("market item refreshes stale cached result sets automatically", () => {
  const content = read("content.js");
  assert.match(content, /if \(!storedItem\.lastResults\?\.length \|\| needsMarketResultRefresh\(storedItem\)\)/);
  assert.match(content, /Atualizando resultados salvos da sessão/);
  assert.match(content, /resultCacheVersion = MARKET_RESULT_CACHE_VERSION/);
});

test("market sources start with Amazon enabled and other default sources disabled", () => {
  const content = read("content.js");
  assert.match(content, /\{\s*id:\s*"amazon"[\s\S]*?enabled:\s*true/);
  assert.match(content, /\{\s*id:\s*"magalu"[\s\S]*?enabled:\s*false/);
  assert.match(content, /\{\s*id:\s*"americanas"[\s\S]*?enabled:\s*false/);
});

test("background capture keeps focus on the current tab while collecting evidence", () => {
  const background = read("background.js");
  assert.match(background, /chrome\.tabs\.create\(\{ url, active: false \}\)/);
  assert.match(background, /captureTabWithDebugger/);
  assert.match(background, /chrome\.debugger\.attach/);
  assert.match(background, /isEvidenceUrlAllowed\(url, capturedUrl\)/);
  assert.match(background, /requestedUrl: url/);
  assert.match(background, /capturedUrl/);
  assert.match(background, /pesqpreco\\\.estaleiro\\\.serpro\\\.gov\\\.br/);
});

test("background forwards item context to the scraper service", () => {
  const background = read("background.js");
  assert.match(background, /itemContext: payload\?\.itemContext \|\| \{\}/);
});

test("report only renders validated screenshots for quote URLs", () => {
  const report = read("report.js");
  assert.match(report, /renderScreenshotEvidence/);
  assert.match(report, /isScreenshotEvidenceValid/);
  assert.match(report, /Screenshot não validado para esta cotação/);
  assert.match(report, /quote\.screenshotUrl/);
  assert.match(report, /pesqpreco\\\.estaleiro\\\.serpro\\\.gov\\\.br/);
});

test("report keeps complete item descriptions and accented labels", () => {
  const report = read("report.js");
  const css = read("report.css");
  assert.match(report, /getReportItemDescription/);
  assert.match(report, /item\.originalDescription/);
  assert.match(report, /item\.canonicalDescription/);
  assert.match(report, /Pesquisa de Preços - Evidências de Mercado/);
  assert.match(report, /Cotações aceitas/);
  assert.match(report, /Menor preço/);
  assert.match(css, /h2 \{[\s\S]*?white-space: normal/);
  assert.match(css, /h2 \{[\s\S]*?overflow-wrap: anywhere/);
});

test("background search normalization does not cap results before UI pagination", () => {
  const background = read("background.js");
  assert.doesNotMatch(background, /source\.slice\(0,\s*10\)/);
});

test("report and background files required by market flow exist", () => {
  for (const filePath of ["background.js", "report.html", "report.js", "report.css", "start-scraper.bat", "restart-scraper.bat"]) {
    assert.ok(fs.existsSync(path.join(repoRoot, filePath)), `${filePath} should exist`);
  }
});

test("catalog enrichment assets are present in the repository", () => {
  for (const filePath of ["tools/generate_catalog_index.py", "catalog/catalog-index.json", "scraper-service/catalog.js"]) {
    assert.ok(fs.existsSync(path.join(repoRoot, filePath)), `${filePath} should exist`);
  }
});
