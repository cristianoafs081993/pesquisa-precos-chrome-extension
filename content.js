(() => {
const EXTENSION_SCRIPT_VERSION = "2.8.3";

if (window.__ppComporExtensionVersion === EXTENSION_SCRIPT_VERSION) {
  return;
}

window.__ppComporExtensionVersion = EXTENSION_SCRIPT_VERSION;

const HEADER_PRICE = ["preco unitario", "preco unit", "valor unitario"];
const HEADER_COMPOR = ["compor"];
const ROW_HIGHLIGHT_CLASS = "pp-compor-preview";
const CLICK_DELAY_MS = 500;
const DELETE_DELAY_MS = 1200;
const MODAL_TIMEOUT_MS = 7000;
const MODAL_CLOSE_TIMEOUT_MS = 3000;
const RULE_RANGE_PERCENT = 0.25;
const MARKET_BUTTON_CLASS = "pp-market-item-button";
const MARKET_STATUS_CLASS = "pp-market-row-status";
const DEFAULT_MARKET_SEARCH_ENDPOINT = "http://10.50.6.5:8787/search";
const MARKET_SOURCE_CONFIG_KEY = "marketSourceConfig";
const MARKET_SOURCE_CONFIG_VERSION = 4;
const MARKET_FREIGHT_CONFIG_KEY = "marketFreightConfig";
const MARKET_PREFETCH_MAX_QUEUE = 8;
const MARKET_PREFETCH_DISABLED_MS = 60000;
const MARKET_RESULT_CACHE_VERSION = 4;
const MARKET_INITIAL_RESULT_COUNT = 3;
const MARKET_RESULT_INCREMENT = 3;
const DEFAULT_MARKET_SOURCES = [
  { id: "amazon", name: "Amazon Brasil", enabled: true, priority: 1, searchUrlTemplate: "https://www.amazon.com.br/s?k={query}" },
  { id: "magalu", name: "Magazine Luiza", enabled: true, priority: 2, searchUrlTemplate: "https://m.magazineluiza.com.br/busca/{query}/" },
  { id: "americanas", name: "Americanas", enabled: true, priority: 3, searchUrlTemplate: "https://www.americanas.com.br/busca/{query}" },
  { id: "casasbahia", name: "Casas Bahia", enabled: false, priority: 4, searchUrlTemplate: "https://www.casasbahia.com.br/{query}/b" },
  { id: "kabum", name: "KaBuM", enabled: false, priority: 5, searchUrlTemplate: "https://www.kabum.com.br/busca/{query}" },
  { id: "dell", name: "Dell Brasil", enabled: false, priority: 6, searchUrlTemplate: "https://www.dell.com/pt-br/search/{query}" },
  { id: "lenovo", name: "Lenovo Brasil", enabled: false, priority: 7, searchUrlTemplate: "https://www.lenovo.com/br/pt/search?text={query}" },
  { id: "maisoffice", name: "MaisOFFICE", enabled: false, priority: 8, searchUrlTemplate: "https://www.maisoffice.com.br/busca?busca={query}" },
  { id: "kalunga", name: "Kalunga", enabled: false, priority: 9, searchUrlTemplate: "https://www.kalunga.com.br/busca/{query}" },
  { id: "fastshop", name: "Fast Shop", enabled: false, priority: 10, searchUrlTemplate: "https://www.fastshop.com.br/web/s/{query}" }
];
const DELETE_REASON_LOW = {
  option: "valor inexequivel",
  justification: "Preco abaixo do minimo configurado."
};
const DELETE_REASON_HIGH = {
  option: "valor excessivamente elevado",
  justification: "Preco acima do maximo configurado."
};

let extensionContextAlive = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PP_RUN_COMPOR_RULE_V2" &&
      message?.type !== "PP_UNDO_COMPOR_RULE_V2" &&
      message?.type !== "PP_SHOW_FLOATING_PANEL_V2" &&
      message?.type !== "PP_GET_COMPOR_RANGE_V2") {
    return false;
  }

  const task = getMessageTask(message);

  task
    .then((result) => {
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Erro inesperado ao executar a regra."
      });
    });

  return true;
});

bootstrapMarketItemPage();

function bootstrapMarketItemPage() {
  if (!location.href.startsWith("https://pesqpreco.estaleiro.serpro.gov.br/")) {
    return;
  }

  const boot = () => {
    if (!document.body) {
      window.setTimeout(boot, 250);
      return;
    }

    // Angular renderiza a tabela de itens de forma tardia; por isso o boot
    // instala o observer e faz novas tentativas curtas apos o carregamento.
    ensureFloatingPanelStyle();
    ensureMarketItemButtons();
    startMarketItemObserver();
    window.setTimeout(ensureMarketItemButtons, 1000);
    window.setTimeout(ensureMarketItemButtons, 2500);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}

function getMessageTask(message) {
  if (message.type === "PP_UNDO_COMPOR_RULE_V2") {
    return undoLastRun();
  }

  if (message.type === "PP_SHOW_FLOATING_PANEL_V2") {
    showFloatingPanel(message.settings);
    return Promise.resolve({ shown: true });
  }

  if (message.type === "PP_GET_COMPOR_RANGE_V2") {
    return Promise.resolve({ range: getSelectedReferenceRange() });
  }

  return runRule(message.action, message.settings);
}

async function runRule(action, settings) {
  ensurePreviewStyle();
  clearPreview();

  const config = normalizeSettings(settings);

  if (action === "delete") {
    return deleteOutOfRange(config);
  }

  const rows = findRows().filter((row) => config.scanAllPages || isVisible(row.element));

  if (!rows.length) {
    throw new Error("Nao encontrei linhas da tabela nesta pagina.");
  }

  const effectiveConfig = resolveRuleConfig(config);
  let scanned = 0;
  let matched = 0;
  let changed = 0;
  let alreadyUnchecked = 0;
  let missingControl = 0;
  const undoItems = [];

  for (const row of rows) {
    const priceText = getCellText(row, row.map.priceIndex);
    const price = parseMoney(priceText);

    if (price === null) {
      continue;
    }

    scanned += 1;

    if (!matchesRule(price, effectiveConfig)) {
      continue;
    }

    matched += 1;

    if (action === "preview") {
      row.element.classList.add(ROW_HIGHLIGHT_CLASS);
      continue;
    }

    const result = uncheckCompor(row);

    if (result === "changed") {
      changed += 1;
      undoItems.push(createUndoItem(row, price));
      await sleep(CLICK_DELAY_MS);
    } else if (result === "unchecked") {
      alreadyUnchecked += 1;
    } else {
      missingControl += 1;
    }
  }

  if (action !== "preview") {
    window.__ppComporLastUndoItems = undoItems;
  }

  return {
    scanned,
    matched,
    changed,
    alreadyUnchecked,
    missingControl,
    range: effectiveConfig.range || null
  };
}

async function undoLastRun() {
  clearPreview();

  const undoItems = Array.isArray(window.__ppComporLastUndoItems)
    ? window.__ppComporLastUndoItems
    : [];

  if (!undoItems.length) {
    throw new Error("Nao ha aplicacao anterior para desfazer nesta aba.");
  }

  let changed = 0;
  let alreadyChecked = 0;
  let missingControl = 0;

  for (const item of undoItems) {
    const row = findRowByUndoItem(item);
    if (!row) {
      missingControl += 1;
      continue;
    }

    const control = getComporControl(getCells(row.element)[row.map.comporIndex]);
    if (!control) {
      missingControl += 1;
      continue;
    }

    if (control.checked) {
      alreadyChecked += 1;
      continue;
    }

    clickControl(control.target);
    changed += 1;
    await sleep(CLICK_DELAY_MS);
  }

  window.__ppComporLastUndoItems = [];

  return {
    changed,
    alreadyChecked,
    missingControl
  };
}

async function deleteOutOfRange(config) {
  const firstRows = findRows().filter((row) => config.scanAllPages || isVisible(row.element));
  if (!firstRows.length) {
    throw new Error("Nao encontrei linhas da tabela nesta pagina.");
  }

  const maxAttempts = Math.max(firstRows.length * 2, 20);
  let changed = 0;
  let missingDeleteButton = 0;
  let modalErrors = 0;
  let scanned = 0;
  let matched = 0;
  let lastRange = null;
  let initialSummaryCaptured = false;
  const skippedRows = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const effectiveConfig = resolveRuleConfig(config);
    lastRange = effectiveConfig.range || lastRange;
    const rows = findRows().filter((row) => config.scanAllPages || isVisible(row.element));
    const summary = summarizeDeleteCandidates(rows, effectiveConfig);

    if (!initialSummaryCaptured) {
      scanned = summary.scanned;
      matched = summary.matched;
      initialSummaryCaptured = true;
    }

    if (!summary.matched) {
      break;
    }

    const candidate = findNextDeleteCandidate(effectiveConfig, skippedRows);
    if (!candidate) {
      break;
    }

    const deleteButton = findDeleteButton(candidate.row.element);
    if (!deleteButton) {
      missingDeleteButton += 1;
      skippedRows.add(candidate.key);
      continue;
    }

    try {
      deleteButton.scrollIntoView({ block: "center", inline: "nearest" });
      deleteButton.click();

      const dialog = await waitForDeleteDialog();
      await chooseDeleteReason(dialog, candidate.reason);
      fillDeleteJustification(dialog, candidate.reason);
      await confirmDelete(dialog);
      await closeDialogAfterConfirm(dialog);

      changed += 1;
      skippedRows.add(candidate.key);
      await sleep(DELETE_DELAY_MS);
    } catch (_error) {
      modalErrors += 1;
      skippedRows.add(candidate.key);
      closeDeleteDialog();
    }
  }

  return {
    scanned,
    matched,
    changed,
    missingDeleteButton,
    modalErrors,
    range: lastRange
  };
}

function summarizeDeleteCandidates(rows, config) {
  let scanned = 0;
  let matched = 0;

  for (const row of rows) {
    const price = parseMoney(getCellText(row, row.map.priceIndex));
    if (price === null) {
      continue;
    }

    scanned += 1;

    if (getDeleteReason(price, config)) {
      matched += 1;
    }
  }

  return { scanned, matched };
}

function findNextDeleteCandidate(config, skippedRows) {
  const rows = findRows().filter((row) => config.scanAllPages || isVisible(row.element));

  for (const row of rows) {
    const price = parseMoney(getCellText(row, row.map.priceIndex));
    if (price === null) {
      continue;
    }

    const reason = getDeleteReason(price, config);
    if (!reason) {
      continue;
    }

    const key = getDeleteRowKey(row, price);
    if (skippedRows.has(key)) {
      continue;
    }

    return { row, price, reason, key };
  }

  return null;
}

function getDeleteReason(price, config) {
  const belowMin = config.min !== null && price < config.min;
  const aboveMax = config.max !== null && price > config.max;

  if (belowMin) {
    return DELETE_REASON_LOW;
  }

  if (aboveMax) {
    return DELETE_REASON_HIGH;
  }

  return null;
}

function getDeleteRowKey(row, price) {
  return `${price}|${normalizeText(row.element.innerText || row.element.textContent || "").slice(0, 500)}`;
}

function normalizeSettings(settings) {
  const mode = "outside";
  const min = parseDecimal(settings?.minPrice);
  const max = parseDecimal(settings?.maxPrice);

  return {
    mode,
    min,
    max,
    dynamicRange: settings?.dynamicRange !== false,
    scanAllPages: settings?.scanAllPages !== false
  };
}

function resolveRuleConfig(config) {
  if (!config.dynamicRange) {
    return config;
  }

  const range = getSelectedReferenceRange();
  return {
    ...config,
    min: range.min,
    max: range.max,
    range
  };
}

function getSelectedReferenceRange() {
  const selection = findSelectedReferenceMetric();
  if (!selection) {
    throw new Error("Nao encontrei a opcao marcada entre Media e Mediana na pagina.");
  }

  const value = findReferenceValueForMetric(selection);
  if (value === null) {
    throw new Error(`Nao encontrei o valor de ${getReferenceMetricLabel(selection.metric)} na pagina.`);
  }

  const min = value * (1 - RULE_RANGE_PERCENT);
  const max = value * (1 + RULE_RANGE_PERCENT);

  return {
    basis: selection.metric,
    basisLabel: getReferenceMetricLabel(selection.metric),
    value,
    min,
    max,
    percent: RULE_RANGE_PERCENT * 100,
    valueFormatted: formatRuleCurrency(value),
    minFormatted: formatRuleCurrency(min),
    maxFormatted: formatRuleCurrency(max)
  };
}

function findSelectedReferenceMetric() {
  const controls = Array.from(document.querySelectorAll("input[type='radio'], [role='radio'], .p-radiobutton, .mat-radio-button, .mat-mdc-radio-button"));

  for (const control of controls) {
    if (!isReferenceControlChecked(control)) {
      continue;
    }

    const nearbyLabel = findNearestReferenceMetricLabel(control);
    if (nearbyLabel) {
      return nearbyLabel;
    }

    const metric = detectReferenceMetric(getMetricSearchText(control));
    if (metric) {
      return {
        metric,
        element: findMetricLabelElement(metric, control) || findVisibleMetricAnchor(control) || control
      };
    }
  }

  return null;
}

function findNearestReferenceMetricLabel(control) {
  const anchorRect = getUsableElementRect(control);
  if (!anchorRect) {
    return null;
  }

  const anchorX = anchorRect.left + anchorRect.width / 2;
  const anchorY = anchorRect.top + anchorRect.height / 2;
  const candidates = Array.from(document.querySelectorAll("body *"))
    .map((element) => {
      const text = getElementOwnText(element) || "";
      const metric = detectReferenceMetric(text);
      if (!metric || text.length > 40 || !isMetricElementVisible(element)) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const verticalDistance = Math.abs(centerY - anchorY);
      if (verticalDistance > 36) {
        return null;
      }

      return {
        metric,
        element,
        score: Math.abs(centerX - anchorX) + verticalDistance * 2
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score);

  return candidates[0] || null;
}

function isReferenceControlChecked(control) {
  if (control.matches?.("input[type='radio']") && control.checked) {
    return true;
  }

  if (control.getAttribute?.("aria-checked") === "true") {
    return true;
  }

  const checkedAncestor = control.closest?.("[aria-checked='true'], .p-radiobutton-checked, .mat-radio-checked, .mat-mdc-radio-checked");
  return Boolean(checkedAncestor);
}

function getMetricSearchText(control) {
  const parts = [];
  const id = control.id || control.querySelector?.("input[type='radio']")?.id || "";
  const label = id ? document.querySelector(`label[for="${cssEscape(id)}"]`) : null;
  const closestLabel = control.closest?.("label");

  if (label) {
    parts.push(label.innerText || label.textContent || "");
  }

  if (closestLabel) {
    parts.push(closestLabel.innerText || closestLabel.textContent || "");
  }

  let current = control;
  for (let depth = 0; current && depth < 4; depth += 1) {
    parts.push(current.innerText || current.textContent || "");
    parts.push(current.previousElementSibling?.innerText || current.previousElementSibling?.textContent || "");
    parts.push(current.nextElementSibling?.innerText || current.nextElementSibling?.textContent || "");
    current = current.parentElement;
  }

  return parts.join(" ");
}

function detectReferenceMetric(text) {
  const normalized = normalizeText(text);
  if (/\bmediana\b/.test(normalized)) {
    return "mediana";
  }

  if (/\bmedia\b/.test(normalized)) {
    return "media";
  }

  return "";
}

function findMetricLabelElement(metric, control) {
  const id = control.id || control.querySelector?.("input[type='radio']")?.id || "";
  const associatedLabel = id ? document.querySelector(`label[for="${cssEscape(id)}"]`) : null;
  if (associatedLabel && detectReferenceMetric(associatedLabel.innerText || associatedLabel.textContent || "") === metric) {
    return associatedLabel;
  }

  const scope = control.closest?.("label, div, section, article, form") || control.parentElement;
  const labels = Array.from((scope || document).querySelectorAll?.("*") || [])
    .filter((element) => {
      const text = getElementOwnText(element) || element.innerText || element.textContent || "";
      return detectReferenceMetric(text) === metric && isMetricElementVisible(element);
    })
    .sort((left, right) => getElementTextLength(left) - getElementTextLength(right));

  return labels[0] || null;
}

function findVisibleMetricAnchor(control) {
  let current = control;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (isMetricElementVisible(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function findReferenceValueForMetric(selection) {
  const anchor = selection.element || null;
  const fromAnchor = findNearestMoneyValue(anchor);
  if (fromAnchor !== null) {
    return fromAnchor;
  }

  const metricLine = findMetricValueFromText(selection.metric);
  if (metricLine !== null) {
    return metricLine;
  }

  return null;
}

function findNearestMoneyValue(anchor) {
  if (!anchor) {
    return null;
  }

  const anchorRect = getUsableElementRect(anchor);
  if (!anchorRect) {
    return null;
  }

  const anchorX = anchorRect.left + anchorRect.width / 2;
  const candidates = Array.from(document.querySelectorAll("body *"))
    .map((element) => {
      const text = getElementOwnText(element) || element.innerText || element.textContent || "";
      if (!/R\$\s*[\d.]+,\d{2,4}/.test(text) || text.length > 120 || !isMetricElementVisible(element)) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const value = parseMoney(text.match(/R\$\s*[\d.]+,\d{2,4}/)?.[0] || text);
      if (value === null) {
        return null;
      }

      const verticalDistance = rect.top - anchorRect.bottom;
      if (verticalDistance < -32 || verticalDistance > 220) {
        return null;
      }

      const centerX = rect.left + rect.width / 2;
      return {
        value,
        score: Math.abs(centerX - anchorX) * 2 + Math.abs(verticalDistance)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score);

  return candidates[0]?.value ?? null;
}

function findMetricValueFromText(metric) {
  const label = getReferenceMetricLabel(metric);
  const lines = String(document.body?.innerText || "").split(/\n+/);

  for (let index = 0; index < lines.length; index += 1) {
    if (detectReferenceMetric(lines[index]) !== metric) {
      continue;
    }

    const nearby = lines.slice(index, index + 4).join(" ");
    const match = nearby.match(/R\$\s*[\d.]+,\d{2,4}/);
    if (match) {
      return parseMoney(match[0]);
    }
  }

  const bodyText = String(document.body?.innerText || "");
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directMatch = bodyText.match(new RegExp(`${escapedLabel}[\\s\\S]{0,120}(R\\$\\s*[\\d.]+,\\d{2,4})`, "i"));
  return directMatch ? parseMoney(directMatch[1]) : null;
}

function getReferenceMetricLabel(metric) {
  return metric === "media" ? "Media" : "Mediana";
}

function getElementOwnText(element) {
  return Array.from(element.childNodes || [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ")
    .trim();
}

function getElementTextLength(element) {
  return String(element.innerText || element.textContent || "").length;
}

function isMetricElementVisible(element) {
  const rect = element.getBoundingClientRect?.();
  const style = window.getComputedStyle?.(element);
  return Boolean(rect) &&
    rect.width > 0 &&
    rect.height > 0 &&
    style?.display !== "none" &&
    style?.visibility !== "hidden";
}

function getUsableElementRect(element) {
  let current = element;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (isMetricElementVisible(current)) {
      return current.getBoundingClientRect();
    }
    current = current.parentElement;
  }

  return null;
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function findRows() {
  const tableRows = findTableRows();
  if (tableRows.length) {
    return tableRows;
  }

  return findGridRows();
}

function findTableRows() {
  const result = [];

  for (const table of document.querySelectorAll("table")) {
    const headers = Array.from(table.querySelectorAll("thead th, thead [role='columnheader'], tr:first-child th"));
    const map = buildColumnMap(headers.map((header) => header.innerText || header.textContent || ""));

    if (!map) {
      continue;
    }

    const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter((row) => {
      return row.querySelectorAll("td, [role='cell'], [role='gridcell']").length > 0;
    });

    for (const element of bodyRows) {
      const rowMap = buildRowMap(element, map);
      if (rowMap) {
        result.push({ element, map: rowMap, type: "table" });
      }
    }
  }

  return result;
}

function findGridRows() {
  const headers = findHeaderCells();
  const map = buildColumnMap(headers.map((header) => header.text));

  if (!map) {
    return [];
  }

  const candidateRows = Array.from(document.querySelectorAll("[role='row'], .mat-row, .mat-mdc-row, tr"));
  const rows = [];

  for (const element of candidateRows) {
    if (isHeaderRow(element)) {
      continue;
    }

    const cells = getCells(element);
    if (cells.length <= Math.max(map.priceIndex, map.comporIndex)) {
      continue;
    }

    const rowMap = buildRowMap(element, map);
    if (!rowMap) {
      continue;
    }

    const price = parseMoney(getCellText({ element, type: "grid" }, rowMap.priceIndex));
    const hasSwitch = Boolean(findComporControl(cells[rowMap.comporIndex]));

    if (price !== null && hasSwitch) {
      rows.push({ element, map: rowMap, type: "grid" });
    }
  }

  return rows;
}

function findHeaderCells() {
  const selectors = [
    "thead th",
    "[role='columnheader']",
    ".mat-header-cell",
    ".mat-mdc-header-cell",
    "th"
  ];

  for (const selector of selectors) {
    const cells = Array.from(document.querySelectorAll(selector))
      .map((element) => ({
        element,
        text: element.innerText || element.textContent || ""
      }))
      .filter((cell) => normalizeText(cell.text));

    if (buildColumnMap(cells.map((cell) => cell.text))) {
      return cells;
    }
  }

  return [];
}

function buildColumnMap(headerTexts) {
  const normalized = headerTexts.map(normalizeText);
  const priceIndex = normalized.findIndex((text) => HEADER_PRICE.some((needle) => text.includes(needle)));
  const comporIndex = normalized.findIndex((text) => HEADER_COMPOR.some((needle) => text.includes(needle)));

  if (priceIndex < 0 || comporIndex < 0) {
    return null;
  }

  return { priceIndex, comporIndex };
}

function buildRowMap(rowElement, headerMap) {
  const cells = getCells(rowElement);
  if (!cells.length) {
    return null;
  }

  const priceIndex = findPriceCellIndex(cells, headerMap.priceIndex);
  const comporIndex = findComporCellIndex(cells, headerMap.comporIndex);

  if (priceIndex < 0) {
    return null;
  }

  return {
    priceIndex,
    comporIndex: comporIndex >= 0 ? comporIndex : headerMap.comporIndex
  };
}

function findPriceCellIndex(cells, fallbackIndex) {
  const byCurrency = cells.findIndex((cell) => /R\$\s*[\d.,]+/.test(cell.innerText || cell.textContent || ""));
  if (byCurrency >= 0) {
    return byCurrency;
  }

  return fallbackIndex;
}

function findComporCellIndex(cells, fallbackIndex) {
  const bySwitch = cells.findIndex((cell) => Boolean(getComporControl(cell)));
  if (bySwitch >= 0) {
    return bySwitch;
  }

  return fallbackIndex;
}

function getCellText(row, index) {
  const cells = getCells(row.element);
  return cells[index]?.innerText || cells[index]?.textContent || "";
}

function getCells(rowElement) {
  return Array.from(rowElement.querySelectorAll(":scope > td, :scope > th, :scope > [role='cell'], :scope > [role='gridcell'], :scope > .mat-cell, :scope > .mat-mdc-cell"));
}

function isHeaderRow(element) {
  return Boolean(element.querySelector("th, [role='columnheader'], .mat-header-cell, .mat-mdc-header-cell"));
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden";
}

function isElementVisible(element) {
  return Boolean(element) && isVisible(element);
}

function matchesRule(price, config) {
  const belowMin = config.min !== null && price < config.min;
  const aboveMax = config.max !== null && price > config.max;
  return belowMin || aboveMax;
}

function uncheckCompor(row) {
  const cells = getCells(row.element);
  const control = getComporControl(cells[row.map.comporIndex]);

  if (!control) {
    return "missing";
  }

  if (!control.checked) {
    return "unchecked";
  }

  clickControl(control.target);
  return "changed";
}

function createUndoItem(row, price) {
  return {
    rowIndex: getRowIndex(row.element),
    price,
    comporIndex: row.map.comporIndex
  };
}

function findRowByUndoItem(item) {
  const rows = findRows();
  const byIndex = rows.find((row) => getRowIndex(row.element) === item.rowIndex);
  if (byIndex) {
    return byIndex;
  }

  return rows.find((row) => {
    const price = parseMoney(getCellText(row, row.map.priceIndex));
    return price === item.price && row.map.comporIndex === item.comporIndex;
  }) || null;
}

function getRowIndex(rowElement) {
  const rows = Array.from(rowElement.parentElement?.children || []);
  return rows.indexOf(rowElement);
}

function findDeleteButton(rowElement) {
  const buttons = Array.from(rowElement.querySelectorAll("button"));

  return buttons.find((button) => {
    const text = normalizeText([
      button.innerText,
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.getAttribute("tooltip"),
      button.getAttribute("ng-reflect-tooltip"),
      button.outerHTML.includes("fa-trash") ? "excluir" : ""
    ].join(" "));

    return text.includes("excluir") || text.includes("trash") || text.includes("lixeira");
  }) || null;
}

async function waitForDeleteDialog() {
  const dialog = await waitFor(() => findDeleteDialog(), MODAL_TIMEOUT_MS);
  if (!dialog) {
    throw new Error("Nao encontrei o popup de justificativa para exclusao.");
  }

  return dialog;
}

function findDeleteDialog() {
  return findDeleteDialogs()[0] || null;
}

function findDeleteDialogs() {
  const candidates = Array.from(document.querySelectorAll([
    "[role='dialog']",
    ".modal",
    ".modal-content",
    ".br-modal",
    ".p-dialog",
    ".p-dialog-content",
    "app-justificativa-exclusao",
    "body"
  ].join(",")));

  const matches = candidates
    .filter(isElementVisible)
    .filter((element) => normalizeText(element.innerText || element.textContent || "").includes("justificativa para exclusao"))
    .map((element) => element.closest?.(".modal-content, [role='dialog'], .br-modal, .p-dialog, .modal") || element);

  return Array.from(new Set(matches))
    .sort((left, right) => {
      const leftLength = (left.innerText || left.textContent || "").length;
      const rightLength = (right.innerText || right.textContent || "").length;
      return leftLength - rightLength;
    });
}

async function chooseDeleteReason(dialog, reason) {
  const nativeSelect = dialog.querySelector("select");
  if (nativeSelect && selectNativeOption(nativeSelect, reason.option)) {
    return;
  }

  const trigger = findReasonTrigger(dialog);
  if (trigger) {
    trigger.scrollIntoView({ block: "center", inline: "nearest" });
    trigger.click();
  }

  const option = await waitFor(() => findReasonOption(reason.option), MODAL_TIMEOUT_MS);
  if (!option) {
    throw new Error("Nao encontrei o motivo de exclusao.");
  }

  option.scrollIntoView({ block: "center", inline: "nearest" });
  option.click();
}

function selectNativeOption(select, optionText) {
  const normalizedOptionText = normalizeText(optionText);
  const option = Array.from(select.options).find((item) => normalizeText(item.textContent || "").includes(normalizedOptionText));
  if (!option) {
    return false;
  }

  select.value = option.value;
  option.selected = true;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function findReasonTrigger(dialog) {
  const selectors = [
    "[role='combobox']",
    ".br-select",
    ".p-dropdown",
    ".ng-select-container",
    "select",
    "input[readonly]",
    "button"
  ];

  const controls = selectors.flatMap((selector) => Array.from(dialog.querySelectorAll(selector)));
  return controls.find((control) => {
    const text = normalizeText([
      control.innerText,
      control.getAttribute("aria-label"),
      control.getAttribute("placeholder"),
      control.getAttribute("name"),
      control.id
    ].join(" "));

    return !text.includes("excluir") && !text.includes("fechar") && !text.includes("justificativa");
  }) || controls[0] || null;
}

function findReasonOption(optionText) {
  const normalizedOptionText = normalizeText(optionText);
  const selectors = [
    "option",
    "[role='option']",
    ".br-item",
    ".p-dropdown-item",
    ".ng-option",
    "li",
    "a",
    "button",
    "span",
    "div"
  ];

  const options = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  return options
    .filter(isVisible)
    .filter((element) => normalizeText(element.innerText || element.textContent || "").includes(normalizedOptionText))
    .sort((left, right) => {
      const leftLength = (left.innerText || left.textContent || "").length;
      const rightLength = (right.innerText || right.textContent || "").length;
      return leftLength - rightLength;
    })[0] || null;
}

function fillDeleteJustification(dialog, reason) {
  const field = dialog.querySelector("textarea, input[type='text']");
  if (!field) {
    return;
  }

  field.value = reason.justification;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function confirmDelete(dialog) {
  const button = await waitFor(() => findConfirmDeleteButton(dialog), MODAL_TIMEOUT_MS);
  if (!button) {
    throw new Error("Nao encontrei o botao Excluir do popup.");
  }

  button.scrollIntoView({ block: "center", inline: "nearest" });
  button.click();
}

function findConfirmDeleteButton(dialog) {
  const buttons = Array.from(dialog.querySelectorAll("button"));
  return buttons.find((button) => {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return false;
    }

    return normalizeText(button.innerText || button.getAttribute("aria-label") || "").includes("excluir");
  }) || null;
}

function closeDeleteDialog() {
  findDeleteDialogs().forEach((dialog) => {
    findCloseDialogButton(dialog)?.click();
  });
}

async function closeDialogAfterConfirm(dialog) {
  const closed = await waitFor(() => !isElementVisible(dialog) && !findDeleteDialog(), MODAL_CLOSE_TIMEOUT_MS);
  if (closed) {
    return;
  }

  closeDeleteDialog();
  await sleep(300);
}

function findCloseDialogButton(dialog) {
  const buttons = Array.from(dialog.querySelectorAll("button"));

  return buttons.find((button) => {
    const text = normalizeText([
      button.innerText,
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.className
    ].join(" "));

    return text.includes("fechar") ||
      text.includes("close") ||
      text.includes("times") ||
      text === "x" ||
      text === "";
  }) || null;
}

function showFloatingPanel(initialSettings) {
  ensureFloatingPanelStyle();
  ensureMarketItemButtons();
  startMarketItemObserver();

  const existing = document.querySelector("#pp-compor-floating-panel");
  if (existing && existing.dataset.ppPanelVersion !== "range-v2") {
    existing.remove();
  } else if (existing) {
    existing.style.display = "block";
    existing.querySelector("[data-pp-status]").textContent = "Painel pronto.";
    if (initialSettings) {
      existing.querySelector("[data-pp-auto-range]").checked = initialSettings.dynamicRange !== false && initialSettings.autoRange !== false;
      if (initialSettings.dynamicRange === false || initialSettings.autoRange === false) {
        existing.querySelector("[data-pp-min]").value = initialSettings.minPrice || "50";
        existing.querySelector("[data-pp-max]").value = initialSettings.maxPrice || "100";
      }
    }
    selectFloatingTab(existing, initialSettings?.activeTab || "adjust");
    ensureMarketItemButtons();
    updateFloatingRangeMode(existing);
    return;
  }

  const settings = {
    mode: "outside",
    minPrice: initialSettings?.minPrice || "50",
    maxPrice: initialSettings?.maxPrice || "100",
    autoRange: initialSettings?.dynamicRange !== false && initialSettings?.autoRange !== false
  };

  const panel = document.createElement("div");
  panel.id = "pp-compor-floating-panel";
  panel.dataset.ppPanelVersion = "range-v2";
  panel.innerHTML = `
    <div class="pp-floating-header" data-pp-drag>
      <strong>Pesquisa de Preços</strong>
      <button type="button" data-pp-close aria-label="Fechar painel">x</button>
    </div>
    <div class="pp-floating-body">
      <div class="pp-floating-tabs" role="tablist" aria-label="Recursos do painel">
        <button type="button" role="tab" data-pp-tab="adjust" aria-selected="true">Ajustar pesquisa</button>
        <button type="button" role="tab" data-pp-tab="market" aria-selected="false">Pesquisa de mercado</button>
      </div>
      <section class="pp-floating-tab-panel" data-pp-tab-panel="adjust">
        <div class="pp-floating-grid">
          <label>
            <span>Minimo</span>
            <input data-pp-min type="text" readonly placeholder="Calculando...">
          </label>
          <label>
            <span>Maximo</span>
            <input data-pp-max type="text" readonly placeholder="Calculando...">
          </label>
        </div>
        <p class="pp-floating-range" data-pp-range-summary>Faixa calculada pela media/mediana selecionada na pagina.</p>
        <label class="pp-floating-check">
          <input data-pp-auto-range type="checkbox">
          <span>Calcular automaticamente pela media/mediana selecionada</span>
        </label>
        <div class="pp-floating-actions">
          <button type="button" data-pp-action="preview">Pre-visualizar</button>
          <button type="button" data-pp-action="apply">Desmarcar</button>
        </div>
        <button type="button" class="pp-floating-secondary" data-pp-action="undo">Desfazer desmarcar</button>
        <button type="button" class="pp-floating-danger" data-pp-action="delete">Excluir abaixo/acima</button>
      </section>
      <section class="pp-floating-tab-panel pp-market-section" data-pp-tab-panel="market" hidden>
        <div class="pp-market-heading">
          <strong>Pesquisa de mercado</strong>
          <div class="pp-market-heading-actions">
            <button type="button" class="pp-floating-secondary" data-pp-sources>Fontes</button>
            <button type="button" class="pp-floating-secondary" data-pp-session>Ver sessão</button>
            <button type="button" class="pp-floating-secondary" data-pp-reset-session>Reiniciar sessão</button>
          </div>
        </div>
        <div class="pp-market-current" data-pp-market-current>Nenhum item selecionado. Use o botão de lupa na tabela de itens.</div>
        <div class="pp-market-results" data-pp-market-results></div>
      </section>
      <div class="pp-floating-status" data-pp-status>Painel pronto.</div>
    </div>
  `;

  document.documentElement.append(panel);

  panel.querySelector("[data-pp-auto-range]").checked = settings.autoRange;
  panel.querySelector("[data-pp-min]").value = settings.minPrice;
  panel.querySelector("[data-pp-max]").value = settings.maxPrice;
  updateFloatingRangeMode(panel);
  window.clearInterval(window.__ppComporRangeRefreshTimer);
  window.__ppComporRangeRefreshTimer = window.setInterval(() => {
    const currentPanel = document.querySelector("#pp-compor-floating-panel");
    if (currentPanel?.style.display !== "none" && currentPanel.querySelector("[data-pp-auto-range]")?.checked) {
      updateFloatingCalculatedRange(currentPanel);
    }
  }, 1500);

  panel.querySelector("[data-pp-close]").addEventListener("click", () => {
    panel.style.display = "none";
  });

  panel.querySelectorAll("[data-pp-action]").forEach((button) => {
    button.addEventListener("click", () => runFloatingAction(panel, button.dataset.ppAction));
  });
  panel.querySelector("[data-pp-auto-range]").addEventListener("change", () => updateFloatingRangeMode(panel));
  panel.querySelectorAll("[data-pp-tab]").forEach((button) => {
    button.addEventListener("click", () => selectFloatingTab(panel, button.dataset.ppTab));
  });
  panel.querySelector("[data-pp-session]").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    renderMarketSession(panel);
  });
  panel.querySelector("[data-pp-sources]").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    renderMarketSourcesConfig(panel);
  });
  panel.querySelector("[data-pp-reset-session]").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetMarketSession(panel);
  });

  selectFloatingTab(panel, initialSettings?.activeTab || "adjust");
  makeFloatingPanelDraggable(panel);
}

function selectFloatingTab(panel, activeTab) {
  const targetTab = activeTab === "market" ? "market" : "adjust";

  panel.querySelectorAll("[data-pp-tab]").forEach((button) => {
    button.setAttribute("aria-selected", button.dataset.ppTab === targetTab ? "true" : "false");
  });

  panel.querySelectorAll("[data-pp-tab-panel]").forEach((section) => {
    section.hidden = section.dataset.ppTabPanel !== targetTab;
  });
}

async function runFloatingAction(panel, action) {
  const status = panel.querySelector("[data-pp-status]");
  const settings = readFloatingSettings(panel);
  const validation = validateFloatingSettings(settings, action);
  if (validation) {
    status.textContent = validation;
    status.classList.add("error");
    return;
  }

  status.classList.remove("error");

  try {
    if (action === "undo") {
      status.textContent = "Desfazendo ultima aplicacao...";
      const response = await undoLastRun();
      status.textContent = `${response.changed} linhas remarcadas.`;
      return;
    }

    const statusByAction = {
      preview: "Analisando linhas...",
      apply: "Desmarcando Compor...",
      delete: "Excluindo itens abaixo/acima..."
    };
    status.textContent = statusByAction[action] || "Executando...";

    const response = await runRule(action, settings);

    if (action === "preview") {
      status.textContent = `${response.matched} linhas encontradas. ${response.scanned} analisadas.`;
    } else if (action === "delete") {
      status.textContent = `${response.changed} excluidas de ${response.matched} abaixo/acima dos limites.`;
    } else {
      status.textContent = `${response.changed} desmarcadas de ${response.matched} encontradas.`;
    }
    updateFloatingCalculatedRange(panel);
  } catch (error) {
    status.classList.add("error");
    status.textContent = error instanceof Error ? error.message : "Erro inesperado.";
  }
}

function readFloatingSettings(panel) {
  const autoRange = panel.querySelector("[data-pp-auto-range]").checked;
  const settings = {
    mode: "outside",
    dynamicRange: autoRange,
    autoRange,
    scanAllPages: true
  };

  if (!autoRange) {
    settings.minPrice = panel.querySelector("[data-pp-min]").value.trim();
    settings.maxPrice = panel.querySelector("[data-pp-max]").value.trim();
  }

  return settings;
}

function validateFloatingSettings(settings, action) {
  if (settings.dynamicRange) {
    return "";
  }

  const min = parseDecimal(settings.minPrice);
  const max = parseDecimal(settings.maxPrice);

  if (min === null) {
    return "Informe um minimo valido.";
  }

  if (max === null) {
    return "Informe um maximo valido.";
  }

  if (min > max) {
    return "O minimo nao pode ser maior que o maximo.";
  }

  return "";
}

function updateFloatingCalculatedRange(panel) {
  if (!panel.querySelector("[data-pp-auto-range]")?.checked) {
    return;
  }

  try {
    const range = getSelectedReferenceRange();
    panel.querySelector("[data-pp-min]").value = range.minFormatted;
    panel.querySelector("[data-pp-max]").value = range.maxFormatted;
    panel.querySelector("[data-pp-range-summary]").textContent = `${range.basisLabel}: ${range.valueFormatted}. Faixa normativa: ${range.minFormatted} a ${range.maxFormatted}.`;
  } catch (_error) {
    panel.querySelector("[data-pp-min]").value = "";
    panel.querySelector("[data-pp-max]").value = "";
    panel.querySelector("[data-pp-range-summary]").textContent = "Nao consegui ler a media/mediana selecionada na pagina.";
  }
}

function updateFloatingRangeMode(panel) {
  const automatic = panel.querySelector("[data-pp-auto-range]").checked;
  panel.querySelector("[data-pp-min]").readOnly = automatic;
  panel.querySelector("[data-pp-max]").readOnly = automatic;

  if (automatic) {
    panel.querySelector("[data-pp-range-summary]").textContent = "Faixa calculada pela media/mediana selecionada na pagina.";
    updateFloatingCalculatedRange(panel);
    return;
  }

  panel.querySelector("[data-pp-range-summary]").textContent = "Faixa manual informada pelo usuario.";
}

function makeFloatingPanelDraggable(panel) {
  const handle = panel.querySelector("[data-pp-drag]");
  let drag = null;

  handle.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    drag = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    panel.classList.add("dragging");
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event) => {
    if (!drag) {
      return;
    }

    const left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, event.clientX - drag.x));
    const top = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, event.clientY - drag.y));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
  });

  window.addEventListener("mouseup", () => {
    drag = null;
    panel.classList.remove("dragging");
  });
}

function ensureFloatingPanelStyle() {
  if (document.querySelector("#pp-floating-panel-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "pp-floating-panel-style";
  style.textContent = `
    #pp-compor-floating-panel {
      position: fixed;
      top: 88px;
      right: 24px;
      z-index: 2147483000;
      width: min(520px, calc(100vw - 24px));
      max-height: calc(100vh - 110px);
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.22);
      color: #17202a;
      font: 14px/1.35 "Segoe UI", Tahoma, sans-serif;
    }
    #pp-compor-floating-panel * {
      box-sizing: border-box;
    }
    #pp-compor-floating-panel [hidden] {
      display: none !important;
    }
    #pp-compor-floating-panel .pp-floating-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: #123f73;
      color: #ffffff;
      border-radius: 12px 12px 0 0;
      cursor: move;
      user-select: none;
    }
    #pp-compor-floating-panel .pp-floating-header button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 28px;
      width: 28px;
      height: 28px;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 999px;
      padding: 0;
      background: transparent;
      color: #ffffff;
      cursor: pointer;
      line-height: 1;
    }
    #pp-compor-floating-panel .pp-floating-body {
      display: grid;
      gap: 10px;
      padding: 12px;
      max-height: calc(100vh - 164px);
      overflow: auto;
    }
    #pp-compor-floating-panel .pp-floating-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 3px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background: #f8fafc;
    }
    #pp-compor-floating-panel .pp-floating-tabs button {
      padding: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: #475569;
      min-height: 36px;
    }
    #pp-compor-floating-panel .pp-floating-tabs button[aria-selected="true"] {
      border-color: #165fbd;
      background: #ffffff;
      color: #123f73;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }
    #pp-compor-floating-panel .pp-floating-tab-panel {
      display: grid;
      gap: 10px;
    }
    #pp-compor-floating-panel label {
      display: grid;
      gap: 5px;
      margin: 0;
      font-weight: 600;
    }
    #pp-compor-floating-panel input,
    #pp-compor-floating-panel select {
      width: 100%;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 8px;
      font: inherit;
      font-weight: 400;
    }
    #pp-compor-floating-panel input[readonly] {
      background: #eef2f6;
      color: #475569;
    }
    #pp-compor-floating-panel .pp-floating-range {
      margin: -2px 0 0;
      color: #475569;
      font-size: 12px;
      line-height: 1.35;
    }
    #pp-compor-floating-panel .pp-floating-grid,
    #pp-compor-floating-panel .pp-floating-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    #pp-compor-floating-panel .pp-floating-check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #475569;
      font-weight: 400;
    }
    #pp-compor-floating-panel .pp-floating-check input {
      width: auto;
    }
    #pp-compor-floating-panel button {
      border: 0;
      border-radius: 8px;
      padding: 9px 10px;
      background: #165fbd;
      color: #ffffff;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }
    #pp-compor-floating-panel button:disabled {
      cursor: default;
      opacity: 0.72;
    }
    #pp-compor-floating-panel .pp-floating-secondary {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #165fbd;
    }
    #pp-compor-floating-panel .pp-floating-danger {
      background: #a93226;
    }
    #pp-compor-floating-panel .pp-floating-status {
      min-height: 18px;
      color: #475569;
    }
    #pp-compor-floating-panel .pp-floating-status.error {
      color: #a93226;
    }
    #pp-compor-floating-panel.dragging {
      opacity: 0.92;
    }
    #pp-compor-floating-panel .pp-market-section {
      display: grid;
      gap: 10px;
    }
    #pp-compor-floating-panel .pp-market-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    #pp-compor-floating-panel .pp-market-heading-actions {
      display: flex;
      gap: 6px;
    }
    #pp-compor-floating-panel .pp-market-heading button {
      padding: 6px 8px;
      font-size: 12px;
    }
    #pp-compor-floating-panel .pp-market-current,
    #pp-compor-floating-panel .pp-market-card,
    #pp-compor-floating-panel .pp-market-session-item {
      border: 1px solid #d8dee8;
      border-radius: 10px;
      padding: 9px;
      background: #f8fafc;
    }
    #pp-compor-floating-panel .pp-market-results {
      display: grid;
      gap: 8px;
    }
    #pp-compor-floating-panel .pp-market-card h4,
    #pp-compor-floating-panel .pp-market-session-item h4 {
      margin: 0 0 4px;
      font-size: 13px;
      color: #123f73;
    }
    #pp-compor-floating-panel .pp-market-card p,
    #pp-compor-floating-panel .pp-market-session-item p {
      margin: 4px 0;
      color: #475569;
    }
    #pp-compor-floating-panel .pp-market-card img {
      width: 54px;
      height: 54px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid #d8dee8;
      float: left;
      margin-right: 8px;
    }
    #pp-compor-floating-panel .pp-market-card.pp-market-card-selected {
      border-color: #93c5fd;
      background: #eff6ff;
    }
    #pp-compor-floating-panel .pp-market-card-actions,
    #pp-compor-floating-panel .pp-market-edit-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      clear: both;
      margin-top: 8px;
    }
    #pp-compor-floating-panel .pp-market-card-actions button,
    #pp-compor-floating-panel .pp-market-session-actions button {
      padding: 7px 8px;
      font-size: 12px;
    }
    #pp-compor-floating-panel .pp-market-muted {
      color: #64748b;
      font-size: 12px;
    }
    #pp-compor-floating-panel .pp-market-success {
      color: #166534;
      font-weight: 700;
    }
    #pp-compor-floating-panel .pp-market-summary {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-top: 8px;
    }
    #pp-compor-floating-panel .pp-market-summary strong {
      display: block;
      font-size: 16px;
      color: #123f73;
    }
    #pp-compor-floating-panel .pp-market-summary span {
      display: block;
      color: #64748b;
      font-size: 11px;
    }
    #pp-compor-floating-panel .pp-market-session-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    #pp-compor-floating-panel .pp-market-list-footer {
      display: grid;
      gap: 8px;
    }
    #pp-compor-floating-panel .pp-market-source-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 8px;
      align-items: start;
      border: 1px solid #d8dee8;
      border-radius: 10px;
      padding: 8px;
      background: #f8fafc;
    }
    #pp-compor-floating-panel .pp-market-source-row input[type="checkbox"] {
      width: auto;
      margin-top: 3px;
    }
    #pp-compor-floating-panel .pp-market-source-row strong,
    #pp-compor-floating-panel .pp-market-source-row span {
      display: block;
    }
    .${MARKET_BUTTON_CLASS} {
      margin-left: 4px !important;
      background: #0f766e !important;
      color: #ffffff !important;
    }
    .${MARKET_STATUS_CLASS} {
      display: inline-block;
      margin-left: 6px;
      padding: 2px 6px;
      border-radius: 999px;
      background: #e0f2fe;
      color: #075985;
      font-size: 11px;
      font-weight: 700;
      vertical-align: middle;
    }
  `;
  document.documentElement.append(style);
}

function startMarketItemObserver() {
  if (window.__ppMarketItemObserver) {
    return;
  }

  window.__ppMarketItemObserver = new MutationObserver(() => {
    if (!extensionContextAlive) {
      stopMarketAutomation();
      return;
    }
    window.clearTimeout(window.__ppMarketItemObserverTimer);
    window.__ppMarketItemObserverTimer = window.setTimeout(ensureMarketItemButtons, 250);
  });
  window.__ppMarketItemObserver.observe(document.body, { childList: true, subtree: true });
}

function ensureMarketItemButtons() {
  if (!extensionContextAlive) {
    return;
  }

  const table = document.querySelector(".tabela-itens p-table, .tabela-itens table") || document.querySelector(".tabela-itens");
  if (!table) {
    return;
  }

  const rows = Array.from(table.querySelectorAll("tbody.p-datatable-tbody tr, tbody tr"))
    .filter((row) => getMarketRowCells(row).length >= 8);

  rows.forEach((row) => {
    const item = parseMarketItemRow(row);

    if (row.querySelector(`.${MARKET_BUTTON_CLASS}`)) {
      refreshMarketRowStatus(row).catch(handleExtensionAsyncError);
      queueMarketPrefetch(item);
      return;
    }

    if (!item) {
      return;
    }

    const actionsCell = getMarketRowCells(row).at(-1);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `br-button circle small text-overflow-descricao ${MARKET_BUTTON_CLASS}`;
    button.title = "Pesquisar mercado";
    button.setAttribute("aria-label", "Pesquisar mercado");
    button.textContent = "M";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMarketItemPanel(parseMarketItemRow(row)).catch(handleExtensionAsyncError);
    });

    actionsCell.append(button);
    refreshMarketRowStatus(row).catch(handleExtensionAsyncError);
    queueMarketPrefetch(item);
  });
}

function getMarketRowCells(row) {
  return Array.from(row.querySelectorAll(":scope > td, :scope > th"));
}

function parseMarketItemRow(row) {
  const cells = getMarketRowCells(row);
  if (cells.length < 8) {
    return null;
  }

  const descricao = getMarketItemDescription(cells[2]);
  const numero = cleanText(cells[1]?.textContent);

  if (!numero || !descricao) {
    return null;
  }

  const item = {
    itemKey: createMarketItemKey(numero, descricao),
    numero,
    descricao,
    originalDescription: descricao,
    catalogCode: extractCatalogCodeFromDescription(descricao),
    quantidade: cleanText(cells[3]?.textContent),
    unidade: cleanText(cells[4]?.textContent),
    atualizadoEm: cleanText(cells[5]?.textContent),
    media: cleanText(cells[6]?.textContent),
    mediana: cleanText(cells[7]?.textContent),
    termoBusca: buildDefaultSearchTerm(descricao),
    queryPrimary: "",
    querySignals: {},
    canonicalDescription: "",
    catalogMatch: null,
    status: "pendente",
    cotacoes: {}
  };

  return item;
}

function createMarketItemKey(numero, descricao) {
  return `${numero}-${normalizeText(descricao).slice(0, 80)}`;
}

function getMarketItemDescription(cell) {
  if (!cell) {
    return "";
  }

  const candidates = [];
  const attributes = [
    "ng-reflect-tooltip",
    "title",
    "aria-label",
    "data-original-title",
    "data-tooltip",
    "tooltip"
  ];
  const elements = [cell, ...Array.from(cell.querySelectorAll("*"))];

  elements.forEach((element) => {
    attributes.forEach((attribute) => {
      const value = element.getAttribute?.(attribute);
      if (value) {
        candidates.push(value);
      }
    });
    candidates.push(element.innerText || element.textContent || "");
  });

  return candidates
    .map(cleanText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || "";
}

function buildDefaultSearchTerm(descricao) {
  return cleanText(stripLeadingCatalogCode(descricao))
    .replace(/\s*,\s*/g, " ")
    .replace(/\b(material|estrutura|cor|aplicacao|caracteristicas adicionais|altura|largura|profundidade)\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function extractCatalogCodeFromDescription(descricao) {
  const match = String(descricao || "").trim().match(/^(\d{5,7})(?:\s*[-–—:/]\s*|\s+)/);
  return match ? match[1] : "";
}

function stripLeadingCatalogCode(descricao) {
  return String(descricao || "").replace(/^\s*\d{5,7}(?:\s*[-–—:/]\s*|\s+)/, "");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function openMarketItemPanel(item) {
  if (!item) {
    return;
  }

  showFloatingPanel({ activeTab: "market" });
  const panel = document.querySelector("#pp-compor-floating-panel");
  panel.style.display = "block";
  selectFloatingTab(panel, "market");
  const storedItem = await upsertMarketItem(item);
  await renderMarketItem(panel, storedItem);
  await refreshMarketRowStatuses();

  if (!storedItem.lastResults?.length || needsMarketResultRefresh(storedItem)) {
    await searchMarketForItem(panel, storedItem, { automatic: true });
  }
}

async function getMarketBackendConfig() {
  const config = await storageGet("sync", {
    marketSearchEndpoint: DEFAULT_MARKET_SEARCH_ENDPOINT,
    marketSearchToken: ""
  });
  if (config.marketSearchEndpoint === "http://localhost:8787/search") {
    config.marketSearchEndpoint = DEFAULT_MARKET_SEARCH_ENDPOINT;
    await storageSet("sync", { marketSearchEndpoint: DEFAULT_MARKET_SEARCH_ENDPOINT });
  }
  return config;
}

async function renderMarketItem(panel, item) {
  const session = await getMarketSession();
  const storedItem = session.items[item.itemKey] || item;
  const acceptedCount = Object.values(storedItem.cotacoes || {}).filter((quote) => quote.status === "accepted").length;
  const current = panel.querySelector("[data-pp-market-current]");
  const results = panel.querySelector("[data-pp-market-results]");
  const staleResults = needsMarketResultRefresh(storedItem);
  panel.dataset.ppCurrentMarketItemKey = storedItem.itemKey;

  current.innerHTML = `
    <strong>Item ${escapeHtml(storedItem.numero)}</strong>
    <p>${escapeHtml(storedItem.descricao)}</p>
    <p class="pp-market-muted">Quantidade: ${escapeHtml(storedItem.quantidade || "-")} ${escapeHtml(storedItem.unidade || "")} | Média: ${escapeHtml(storedItem.media || "-")} | Cotações aceitas: ${acceptedCount}/3</p>
    <label>
      <span>Termo de busca</span>
      <input data-pp-market-query type="text" value="${escapeHtml(storedItem.queryPrimary || storedItem.termoBusca || buildDefaultSearchTerm(storedItem.descricao))}">
    </label>
    <div class="pp-market-card-actions">
      <button type="button" data-pp-market-search>Buscar mercado</button>
      <button type="button" class="pp-floating-secondary" data-pp-market-export>Exportar sessão</button>
      <button type="button" class="pp-floating-secondary" data-pp-market-import>Importar sessão</button>
      <button type="button" class="pp-floating-secondary" data-pp-market-report>Gerar relatório</button>
    </div>
  `;

  if (storedItem.lastResults?.length && !staleResults) {
    results.innerHTML = renderMarketResults(storedItem, storedItem.lastResults);
    attachMarketResultEvents(panel, storedItem, storedItem.lastResults);
  } else if (staleResults) {
    results.innerHTML = `<div class="pp-market-muted">Atualizando resultados salvos da sessão...</div>`;
  } else {
    results.innerHTML = renderAcceptedQuotes(storedItem);
  }

  current.querySelector("[data-pp-market-search]").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    searchMarketForItem(panel, storedItem, { trigger: event.currentTarget });
  });
  current.querySelector("[data-pp-market-export]").addEventListener("click", exportMarketSession);
  current.querySelector("[data-pp-market-import]").addEventListener("click", importMarketSession);
  current.querySelector("[data-pp-market-report]").addEventListener("click", openMarketReport);
}

async function renderCurrentMarketView(panel) {
  const currentItemKey = panel.dataset.ppCurrentMarketItemKey;
  if (currentItemKey) {
    const session = await getMarketSession();
    const item = session.items[currentItemKey];
    if (item) {
      await renderMarketItem(panel, item);
      return;
    }
  }

  renderMarketHome(panel);
}

function renderMarketHome(panel) {
  delete panel.dataset.ppCurrentMarketItemKey;
  panel.querySelector("[data-pp-status]").classList.remove("error");
  panel.querySelector("[data-pp-status]").textContent = "Painel pronto.";
  panel.querySelector("[data-pp-market-current]").innerHTML = "Nenhum item selecionado. Use o botão de lupa na tabela de itens.";
  panel.querySelector("[data-pp-market-results]").innerHTML = "";
}

function renderAcceptedQuotes(item) {
  const quotes = Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted");
  if (!quotes.length) {
    return `<div class="pp-market-muted">Nenhuma cotação aceita ainda.</div>`;
  }

  return quotes.map((quote) => {
    const freightTotal = formatQuoteFreightTotal(quote);
    const effectivePrice = formatQuoteEffectivePrice(quote);

    return `
    <article class="pp-market-card">
      ${quote.thumbnailLink ? `<img alt="" src="${escapeAttribute(quote.thumbnailLink)}">` : ""}
      <h4>${escapeHtml(quote.titulo)}</h4>
      ${freightTotal || effectivePrice ? `
      <div class="pp-market-edit-grid">
        <input value="${escapeAttribute(freightTotal)}" placeholder="Frete total para a quantidade" readonly>
        <input value="${escapeAttribute(effectivePrice)}" placeholder="Preco unitario com frete" readonly>
      </div>
      ` : ""}
      <p class="pp-market-muted">${escapeHtml(getFreightStatusLabel(quote))}</p>
      <p>${escapeHtml(quote.dominio)} | ${escapeHtml(quote.precoEditado || "preço não informado")}</p>
      <p class="pp-market-success">Selecionada para relatório</p>
    </article>
  `;
  }).join("");
}

async function searchMarketForItem(panel, item, options = {}) {
  const status = panel.querySelector("[data-pp-status]");
  const results = panel.querySelector("[data-pp-market-results]");
  const queryInput = panel.querySelector("[data-pp-market-query]");
  const trigger = options.trigger;

  if (trigger) {
    trigger.disabled = true;
  }

  status.classList.remove("error");
  try {
    if (!queryInput) {
      throw new Error("Não encontrei o campo de termo de busca. Reabra o item pelo botão M.");
    }
    const query = queryInput.value.trim();

    if (!query) {
      throw new Error("Informe um termo de busca para pesquisar mercado.");
    }

    status.textContent = options.automatic
      ? "Item selecionado. Buscando preços no serviço local..."
      : "Buscando preços no serviço local...";
    results.innerHTML = `<div class="pp-market-muted">Consultando fornecedores configurados. Mantenha o serviço local em execução.</div>`;
    const config = await getMarketBackendConfig();
    const sources = await getEnabledMarketSources();
    if (!sources.length) {
      throw new Error("Nenhuma fonte de pesquisa ativa. Abra Fontes e marque ao menos uma fonte.");
    }

    const session = await getMarketSession();
    session.items[item.itemKey] = {
      ...session.items[item.itemKey],
      termoBusca: query,
      status: "em pesquisa"
    };
    await saveMarketSession(session);

    // A busca roda no background script para evitar restricoes de CORS da pagina
    // do Compras.gov.br e manter um contrato unico com o servico local.
    const response = await sendRuntimeMessage({
      type: "PP_MARKET_SEARCH",
      payload: {
        endpoint: config.marketSearchEndpoint || DEFAULT_MARKET_SEARCH_ENDPOINT,
        token: config.marketSearchToken,
        query,
        itemId: item.itemKey,
        pesquisaId: session.pesquisaId,
        providers: buildMarketProviderPayload(sources),
        itemContext: {
          numero: item.numero,
          description: item.descricao,
          originalDescription: item.originalDescription || item.descricao,
          catalogCode: item.catalogCode || extractCatalogCodeFromDescription(item.descricao)
        }
      }
    });

    if (!response.ok) {
      throw new Error(response.message || "Busca falhou.");
    }

    session.items[item.itemKey].lastResults = response.results || [];
    session.items[item.itemKey].ignoredResults = {};
    session.items[item.itemKey].resultCacheVersion = MARKET_RESULT_CACHE_VERSION;
    session.items[item.itemKey].catalogMatch = response.enrichment?.catalogMatch || null;
    session.items[item.itemKey].canonicalDescription = response.enrichment?.canonicalDescription || session.items[item.itemKey].descricao;
    session.items[item.itemKey].queryPrimary = response.enrichment?.queryPrimary || query;
    session.items[item.itemKey].querySignals = response.enrichment?.querySignals || {};
    session.items[item.itemKey].termoBusca = response.enrichment?.queryPrimary || query;
    await saveMarketSession(session);
    setMarketVisibleResultLimit(item.itemKey, MARKET_INITIAL_RESULT_COUNT);
    const storedItem = session.items[item.itemKey];
    results.innerHTML = renderMarketResults(storedItem, storedItem.lastResults);
    attachMarketResultEvents(panel, storedItem, storedItem.lastResults);
    const validResultCount = filterRenderableMarketResults(storedItem.lastResults, storedItem).length;
    status.textContent = validResultCount
      ? `${validResultCount} produtos fiéis ao termo com preço retornados.`
      : "0 produtos fiéis ao termo com preço retornados. Ajuste o termo ou habilite outra fonte em Fontes.";
    await refreshMarketRowStatuses();
  } catch (error) {
    status.classList.add("error");
    status.textContent = error instanceof Error ? error.message : "Busca falhou.";
    results.innerHTML = `<div class="pp-market-muted">${escapeHtml(status.textContent)}</div>`;
  } finally {
    if (trigger) {
      trigger.disabled = false;
    }
  }
}

function renderMarketResults(item, results) {
  const validResults = getRenderableMarketResults(item, results);
  if (!validResults.length) {
    return `<div class="pp-market-muted">Nenhum produto fiel ao termo de busca foi retornado pelas fontes ativas. Ajuste o termo ou habilite outra fonte em Fontes.</div>`;
  }

  const displayLimit = getMarketVisibleResultLimit(item);
  const visibleResults = validResults.slice(0, displayLimit);
  const hasMore = validResults.length > visibleResults.length;

  return `
    ${visibleResults.map((result, index) => {
      const quote = getAcceptedQuoteForResult(item, result);
      const isAccepted = Boolean(quote);
      const actionLabel = isAccepted ? "Já no relatório" : "Usar no relatório";
      const freightStatus = getFreightStatusLabel(quote);
      const displayTitle = quote?.titulo || result.title || "";
      const displayDomain = quote?.dominio || result.displayLink || "";
      const displaySnippet = quote?.snippet || result.snippet || "";
      const thumbnailLink = quote?.thumbnailLink || result.thumbnailLink || "";
      const priceValue = quote?.precoEditado || result.price || "";
      const supplierValue = quote?.fornecedorEditado || quote?.dominio || result.displayLink || "";
      const freightTotal = formatQuoteFreightTotal(quote);
      const effectivePrice = formatQuoteEffectivePrice(quote);
      const noteValue = quote?.observacao || "";

      return `
    <article class="pp-market-card${isAccepted ? " pp-market-card-selected" : ""}" data-pp-result-index="${index}">
      ${thumbnailLink ? `<img alt="" src="${escapeAttribute(thumbnailLink)}">` : ""}
      <h4>${escapeHtml(displayTitle)}</h4>
      <p>${escapeHtml(displayDomain)}</p>
      <p>${escapeHtml(displaySnippet)}</p>
      <div class="pp-market-edit-grid">
        <input data-pp-price placeholder="Preço encontrado" value="${escapeAttribute(priceValue)}">
        <input data-pp-supplier placeholder="Fornecedor" value="${escapeAttribute(supplierValue)}">
      </div>
      <div class="pp-market-edit-grid">
        <input data-pp-freight-total placeholder="Frete total para a quantidade" value="${escapeAttribute(freightTotal)}">
        <input data-pp-effective-price placeholder="Preço unitário com frete" value="${escapeAttribute(effectivePrice)}" readonly>
      </div>
      <input data-pp-note placeholder="Observação/aderência do produto" value="${escapeAttribute(noteValue)}">
      <p class="pp-market-muted" data-pp-freight-status>${escapeHtml(freightStatus)}</p>
      <div class="pp-market-card-actions">
        <button type="button" data-pp-open-result>Abrir pagina</button>
        <button type="button" class="pp-floating-secondary" data-pp-use-result ${isAccepted ? "disabled" : ""}>${actionLabel}</button>
        <button type="button" class="pp-floating-secondary" data-pp-ignore-result ${isAccepted ? "disabled" : ""}>Ignorar</button>
      </div>
      <p class="${isAccepted ? "pp-market-success" : "pp-market-muted"}" data-pp-result-status>${isAccepted ? `Cotação já incluída no relatório${quote?.screenshotId ? " com evidência capturada" : ""}.` : ""}</p>
    </article>
    `;
    }).join("")}
    <div class="pp-market-list-footer">
      <span class="pp-market-muted">Mostrando ${visibleResults.length} de ${validResults.length} resultados fiéis ao termo.</span>
      ${hasMore ? `<button type="button" class="pp-floating-secondary" data-pp-load-more-results>Carregar mais resultados</button>` : ""}
    </div>
  `;
}

function getFreightStatusLabel(quote) {
  if (!quote) {
    return "Frete: tentativa automática pela Amazon; preencha manualmente se não for encontrado.";
  }

  if (quote.freteStatus === "free") {
    return "Frete grátis considerado no relatório.";
  }

  if (quote.freteStatus === "captured") {
    return `Frete capturado automaticamente: ${formatMoneyValue(quote.freteTotal)}.`;
  }

  if (quote.freteStatus === "manual") {
    return `Frete informado manualmente: ${formatMoneyValue(quote.freteTotal)}.`;
  }

  return "Frete pendente.";
}

function formatQuoteFreightTotal(quote) {
  return quote?.freteTotal !== undefined && quote?.freteTotal !== null
    ? formatMoneyValue(quote.freteTotal)
    : "";
}

function formatQuoteEffectivePrice(quote) {
  return quote?.precoUnitarioComFrete !== undefined && quote?.precoUnitarioComFrete !== null
    ? formatMoneyValue(quote.precoUnitarioComFrete)
    : "";
}

function getRenderableMarketResults(item, results) {
  const acceptedQuotes = Object.values(item?.cotacoes || {}).filter((quote) => quote.status === "accepted");
  const acceptedResults = acceptedQuotes.map(quoteToMarketResult).filter((result) => result.link && result.title);
  const validResults = filterRenderableMarketResults(results, item)
    .filter((result) => !getAcceptedQuoteForResult(item, result));

  return [...acceptedResults, ...validResults];
}

function quoteToMarketResult(quote) {
  return {
    link: quote.url || quote.screenshotRequestedUrl || quote.screenshotUrl || "",
    title: quote.titulo || "",
    displayLink: quote.fornecedorEditado || quote.dominio || "",
    snippet: quote.snippet || "",
    price: quote.precoEditado || "",
    thumbnailLink: quote.thumbnailLink || "",
    provider: quote.provider || ""
  };
}

function filterRenderableMarketResults(results, itemOrQuery = "") {
  if (!Array.isArray(results)) return [];
  const query = typeof itemOrQuery === "string"
    ? itemOrQuery
    : itemOrQuery?.queryPrimary || itemOrQuery?.termoBusca;
  const ignoredResults = typeof itemOrQuery === "object" && itemOrQuery ? itemOrQuery.ignoredResults || {} : {};

  return results.filter((result) => {
    return result &&
      result.status !== "error" &&
      result.link &&
      result.title &&
      result.price &&
      !ignoredResults[createQuoteId(result.link)] &&
      isMarketResultRelevant(result, itemOrQuery);
  }).sort((left, right) => scoreMarketResult(right, itemOrQuery) - scoreMarketResult(left, itemOrQuery));
}

function attachMarketResultEvents(panel, item, results) {
  const validResults = getRenderableMarketResults(item, results).slice(0, getMarketVisibleResultLimit(item));
  panel.querySelectorAll("[data-pp-result-index]").forEach((card) => {
    const index = Number(card.dataset.ppResultIndex);
    const result = validResults[index];
    if (!result) return;
    card.querySelector("[data-pp-open-result]").addEventListener("click", () => {
      sendRuntimeMessage({ type: "PP_MARKET_OPEN_URL", payload: { url: result.link } });
    });
    card.querySelector("[data-pp-price]")?.addEventListener("input", () => updateFreightPreview(card, item));
    card.querySelector("[data-pp-freight-total]")?.addEventListener("input", () => updateFreightPreview(card, item));
    card.querySelector("[data-pp-use-result]")?.addEventListener("click", () => captureAndAcceptMarketResult(panel, item, result, card));
    card.querySelector("[data-pp-ignore-result]")?.addEventListener("click", () => {
      ignoreMarketResult(panel, item, result);
    });
  });
  panel.querySelector("[data-pp-load-more-results]")?.addEventListener("click", async () => {
    setMarketVisibleResultLimit(item.itemKey, getMarketVisibleResultLimit(item) + MARKET_RESULT_INCREMENT);
    await renderMarketItem(panel, item);
  });
}

function updateFreightPreview(card, item) {
  const price = parseMoney(card.querySelector("[data-pp-price]")?.value);
  const freight = parseMoney(card.querySelector("[data-pp-freight-total]")?.value);
  const quantityInfo = getQuantityInfo(item);
  const target = card.querySelector("[data-pp-effective-price]");

  if (!target || price === null || freight === null) {
    if (target) target.value = "";
    return;
  }

  target.value = formatMoneyValue(price + (freight / quantityInfo.quantity));
}

function getMarketVisibleResultLimit(item) {
  window.__ppMarketVisibleResultLimits ||= {};
  const itemKey = item?.itemKey || "default";
  return window.__ppMarketVisibleResultLimits[itemKey] || MARKET_INITIAL_RESULT_COUNT;
}

function setMarketVisibleResultLimit(itemKey, limit) {
  window.__ppMarketVisibleResultLimits ||= {};
  window.__ppMarketVisibleResultLimits[itemKey || "default"] = Math.max(MARKET_INITIAL_RESULT_COUNT, limit);
}

function needsMarketResultRefresh(item) {
  return Boolean(item?.lastResults?.length) && item.resultCacheVersion !== MARKET_RESULT_CACHE_VERSION;
}

async function ignoreMarketResult(panel, item, result) {
  const session = await getMarketSession();
  const storedItem = session.items[item.itemKey] || item;
  storedItem.ignoredResults = {
    ...(storedItem.ignoredResults || {}),
    [createQuoteId(result.link)]: new Date().toISOString()
  };
  session.items[item.itemKey] = storedItem;
  await saveMarketSession(session);
  await renderMarketItem(panel, storedItem);
}

function getAcceptedQuoteForResult(item, result) {
  const quote = item?.cotacoes?.[createQuoteId(result.link)];
  if (quote?.status === "accepted") {
    return quote;
  }

  const resultUrlKey = normalizeQuoteUrlForMatch(result?.link);
  if (!resultUrlKey) {
    return null;
  }

  return Object.values(item?.cotacoes || {}).find((itemQuote) => {
    return itemQuote?.status === "accepted" &&
      (
        normalizeQuoteUrlForMatch(itemQuote.url || itemQuote.screenshotRequestedUrl) === resultUrlKey ||
        isLikelySameMarketQuote(itemQuote, result)
      );
  }) || null;
}

function isLikelySameMarketQuote(quote, result) {
  const quoteDomain = normalizeMarketDomainForMatch(quote.fornecedorEditado || quote.dominio || quote.url);
  const resultDomain = normalizeMarketDomainForMatch(result.displayLink || result.link);
  if (!quoteDomain || !resultDomain || quoteDomain !== resultDomain) {
    return false;
  }

  return getTitleSimilarity(quote.titulo, result.title) >= 0.72;
}

function normalizeQuoteUrlForMatch(value) {
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^(www|m)\./i, "").toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/g, "").toLowerCase();
    return `${hostname}${pathname}`;
  } catch (error) {
    return String(value).split(/[?#]/)[0].replace(/\/+$/g, "").toLowerCase();
  }
}

function normalizeMarketDomainForMatch(value) {
  if (!value) {
    return "";
  }

  try {
    const parsed = String(value).startsWith("http")
      ? new URL(value)
      : new URL(`https://${String(value).replace(/^\/+/, "")}`);
    return parsed.hostname.replace(/^(www|m)\./i, "").toLowerCase();
  } catch (error) {
    return String(value)
      .replace(/^https?:\/\//i, "")
      .split(/[/?#]/)[0]
      .replace(/^(www|m)\./i, "")
      .toLowerCase();
  }
}

function getTitleSimilarity(left, right) {
  const leftTokens = getTitleMatchTokens(left);
  const rightTokens = getTitleMatchTokens(right);
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  const matches = leftTokens.filter((token) => rightSet.has(token)).length;
  return matches / Math.max(leftTokens.length, rightTokens.length);
}

function getTitleMatchTokens(value) {
  return Array.from(new Set(normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3)));
}

function isMarketResultRelevant(result, itemOrQuery) {
  if (scoreMarketResult(result, itemOrQuery) <= 0) {
    return false;
  }

  const query = typeof itemOrQuery === "string"
    ? itemOrQuery
    : itemOrQuery?.queryPrimary || itemOrQuery?.termoBusca;
  const tokens = getMarketSearchTokens(query);
  if (!tokens.length && !itemOrQuery?.querySignals) {
    return true;
  }

  return scoreMarketResult(result, itemOrQuery) >= Math.max(6, tokens.length * 3);
}

function getMarketSearchTokens(query) {
  const stopWords = new Set([
    "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas", "no", "nos", "o", "os", "ou", "para", "por"
  ]);

  return Array.from(new Set(normalizeText(query)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token))));
}

function singularizeToken(token) {
  if (token.length <= 4 || !token.endsWith("s")) {
    return token;
  }

  return token.slice(0, -1);
}

function scoreMarketResult(result, itemOrQuery) {
  if (!result) {
    return 0;
  }

  const item = typeof itemOrQuery === "object" && itemOrQuery ? itemOrQuery : {};
  const query = typeof itemOrQuery === "string" ? itemOrQuery : item.queryPrimary || item.termoBusca || "";
  const signals = item.querySignals || {};
  const text = normalizeText([
    result.title,
    result.snippet,
    result.displayLink,
    result.providerName
  ].join(" "));

  const matchTokens = (value, weight) => {
    return getMarketSearchTokens(value).reduce((sum, token) => {
      return sum + (text.includes(token) ? weight : 0);
    }, 0);
  };

  let score = 0;
  score += matchTokens(query, 5);
  score += matchTokens(signals.pdm, 6);
  score += matchTokens(item.canonicalDescription, 3);
  score += matchTokens(signals.classe, 2);
  score += matchTokens(signals.grupo, 1);

  if (signals.ncm && text.includes(String(signals.ncm))) {
    score += 8;
  }

  return score;
}

async function captureAndAcceptMarketResult(panel, item, result, card) {
  const status = card.querySelector("[data-pp-result-status]");
  const useButton = card.querySelector("[data-pp-use-result]");
  const ignoreButton = card.querySelector("[data-pp-ignore-result]");
  const manualFreight = parseMoney(card.querySelector("[data-pp-freight-total]")?.value);
  const freightConfig = await getMarketFreightConfig();

  if (!freightConfig.cep && manualFreight === null) {
    status.className = "pp-market-muted";
    status.textContent = "Configure um CEP em Fontes ou informe manualmente o frete total para a quantidade do item.";
    return;
  }

  if (manualFreight !== null && manualFreight < 0) {
    status.className = "pp-market-muted";
    status.textContent = "Informe um frete total maior ou igual a zero.";
    return;
  }

  status.className = "pp-market-muted";
  status.textContent = "Abrindo aba em segundo plano e capturando evidência...";
  if (useButton) useButton.disabled = true;
  if (ignoreButton) ignoreButton.disabled = true;

  try {
    const response = await sendRuntimeMessage({
      type: "PP_MARKET_CAPTURE",
      payload: {
        url: result.link,
        freightZip: freightConfig.cep
      }
    });

    if (!response.ok) {
      throw new Error(response.message || "Falha na captura.");
    }

    const screenshotId = await saveScreenshot(response.screenshotData);
    const freight = resolveFreightForQuote({
      capturedFreight: response.freight,
      manualFreight,
      freightZip: freightConfig.cep
    });

    if (freight.status === "pending") {
      const detail = freight.mensagem ? ` (${freight.mensagem})` : "";
      status.textContent = `Frete não encontrado automaticamente${detail}. Informe o frete total para a quantidade do item e tente novamente.`;
      if (useButton) useButton.disabled = false;
      if (ignoreButton) ignoreButton.disabled = false;
      return;
    }

    await acceptMarketResult(panel, item, result, card, {
      screenshotId,
      screenshotUrl: response.capturedUrl || result.link,
      screenshotRequestedUrl: response.requestedUrl || result.link,
      openedTabId: response.openedTabId || null,
      capturadoEm: response.capturedAt,
      freight
    });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Falha na captura.";
    if (useButton) useButton.disabled = false;
    if (ignoreButton) ignoreButton.disabled = false;
  }
}

function resolveFreightForQuote({ capturedFreight, manualFreight, freightZip }) {
  if (capturedFreight?.status === "free") {
    return {
      status: "free",
      total: 0,
      origem: "amazon-auto",
      cep: capturedFreight.cep || freightZip || "",
      mensagem: capturedFreight.text || "Frete grátis"
    };
  }

  if (capturedFreight?.status === "captured" && Number.isFinite(Number(capturedFreight.total))) {
    return {
      status: "captured",
      total: Number(capturedFreight.total),
      origem: "amazon-auto",
      cep: capturedFreight.cep || freightZip || "",
      mensagem: capturedFreight.text || ""
    };
  }

  if (manualFreight !== null && manualFreight >= 0) {
    return {
      status: "manual",
      total: manualFreight,
      origem: "manual",
      cep: freightZip || "",
      mensagem: capturedFreight?.text || ""
    };
  }

  return {
    status: "pending",
    total: null,
    origem: "",
    cep: freightZip || "",
    mensagem: capturedFreight?.text || ""
  };
}

async function acceptMarketResult(panel, item, result, card, capture) {
  const session = await getMarketSession();
  const storedItem = session.items[item.itemKey] || item;
  const quoteId = createQuoteId(result.link);
  const priceValue = parseMoney(card.querySelector("[data-pp-price]").value.trim());
  const freight = capture?.freight || { status: "pending", total: null, origem: "", cep: "" };
  const quantityInfo = getQuantityInfo(storedItem);
  const freightTotal = Number.isFinite(Number(freight.total)) ? Number(freight.total) : null;
  const freightUnit = freightTotal !== null ? freightTotal / quantityInfo.quantity : null;
  const effectiveUnitPrice = priceValue !== null && freightUnit !== null ? priceValue + freightUnit : null;
  const quote = {
    itemNumero: storedItem.numero,
    titulo: result.title,
    url: result.link,
    dominio: result.displayLink,
    snippet: result.snippet,
    thumbnailLink: result.thumbnailLink || "",
    precoEditado: card.querySelector("[data-pp-price]").value.trim(),
    precoUnitario: priceValue,
    fornecedorEditado: card.querySelector("[data-pp-supplier]").value.trim(),
    observacao: card.querySelector("[data-pp-note]").value.trim(),
    freteTotal: freightTotal,
    freteStatus: freight.status,
    freteOrigem: freight.origem,
    freteCep: freight.cep,
    freteMensagem: freight.mensagem || "",
    quantidadeConsiderada: quantityInfo.quantity,
    quantidadeAviso: quantityInfo.warning,
    freteUnitario: freightUnit,
    precoUnitarioComFrete: effectiveUnitPrice,
    screenshotId: capture?.screenshotId || storedItem.cotacoes?.[quoteId]?.screenshotId || "",
    screenshotUrl: capture?.screenshotUrl || storedItem.cotacoes?.[quoteId]?.screenshotUrl || "",
    screenshotRequestedUrl: capture?.screenshotRequestedUrl || storedItem.cotacoes?.[quoteId]?.screenshotRequestedUrl || result.link || "",
    openedTabId: capture?.openedTabId || storedItem.cotacoes?.[quoteId]?.openedTabId || null,
    capturadoEm: capture?.capturadoEm || storedItem.cotacoes?.[quoteId]?.capturadoEm || new Date().toISOString(),
    status: "accepted"
  };

  storedItem.cotacoes = {
    ...(storedItem.cotacoes || {}),
    [quoteId]: quote
  };
  storedItem.status = Object.values(storedItem.cotacoes).filter((itemQuote) => itemQuote.status === "accepted").length >= 3
    ? "relatorio"
    : "em pesquisa";
  session.items[item.itemKey] = storedItem;
  await saveMarketSession(session);
  await renderMarketItem(panel, storedItem);
  await refreshMarketRowStatuses();
}

async function renderMarketSession(panel) {
  const session = await getMarketSession();
  const items = Object.values(session.items || {});
  const results = panel.querySelector("[data-pp-market-results]");
  const totalQuotes = items.reduce((sum, item) => {
    return sum + Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted").length;
  }, 0);
  const completeItems = items.filter((item) => {
    return Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted").length >= 3;
  }).length;

  panel.querySelector("[data-pp-status]").classList.remove("error");
  panel.querySelector("[data-pp-status]").textContent = `Sessão aberta: ${items.length} itens, ${totalQuotes} cotações aceitas.`;
  panel.querySelector("[data-pp-market-current]").innerHTML = `
    <strong>Sessão ${escapeHtml(session.pesquisaId)}</strong>
    <p class="pp-market-muted">Resumo local da pesquisa de mercado. Estes dados ficam no armazenamento local da extensao.</p>
    <div class="pp-market-summary">
      <div><strong>${items.length}</strong><span>itens</span></div>
      <div><strong>${completeItems}</strong><span>com 3+ cotacoes</span></div>
      <div><strong>${totalQuotes}</strong><span>cotacoes aceitas</span></div>
    </div>
    <div class="pp-market-card-actions">
      <button type="button" class="pp-floating-secondary" data-pp-market-back>Voltar ao item</button>
      <button type="button" class="pp-floating-secondary" data-pp-market-export>Exportar sessão</button>
      <button type="button" class="pp-floating-secondary" data-pp-market-import>Importar sessão</button>
      <button type="button" class="pp-floating-secondary" data-pp-reset-session-view>Reiniciar sessão</button>
      <button type="button" data-pp-market-report>Gerar relatório</button>
    </div>
  `;
  panel.querySelector("[data-pp-market-back]").addEventListener("click", () => renderCurrentMarketView(panel));
  panel.querySelector("[data-pp-market-export]").addEventListener("click", exportMarketSession);
  panel.querySelector("[data-pp-market-import]").addEventListener("click", importMarketSession);
  panel.querySelector("[data-pp-reset-session-view]").addEventListener("click", () => resetMarketSession(panel));
  panel.querySelector("[data-pp-market-report]").addEventListener("click", openMarketReport);
  results.innerHTML = items.map((item) => {
    const count = Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted").length;
    const lastResultsCount = filterRenderableMarketResults(item.lastResults || [], item).length;
    return `
      <article class="pp-market-session-item">
        <h4>Item ${escapeHtml(item.numero)} - ${escapeHtml(item.descricao)}</h4>
        <p>${escapeHtml(item.quantidade || "-")} ${escapeHtml(item.unidade || "")} | ${count}/3 cotacoes | ${lastResultsCount} resultados | ${escapeHtml(item.status || "pendente")}</p>
        <p class="pp-market-muted">Termo: ${escapeHtml(item.termoBusca || "-")}</p>
        <div class="pp-market-session-actions">
          <button type="button" class="pp-floating-secondary" data-pp-open-session-item="${escapeAttribute(item.itemKey)}">Abrir item</button>
        </div>
      </article>
    `;
  }).join("") || `<div class="pp-market-muted">Nenhum item selecionado.</div>`;

  results.querySelectorAll("[data-pp-open-session-item]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = (await getMarketSession()).items[button.dataset.ppOpenSessionItem];
      if (item) {
        await renderMarketItem(panel, item);
        if (!item.lastResults?.length || needsMarketResultRefresh(item)) {
          await searchMarketForItem(panel, item, { automatic: true });
        }
      }
    });
  });
}

async function renderMarketSourcesConfig(panel) {
  const config = await getMarketSourceConfig();
  const freightConfig = await getMarketFreightConfig();
  const current = panel.querySelector("[data-pp-market-current]");
  const results = panel.querySelector("[data-pp-market-results]");
  const enabledCount = config.sources.filter((source) => source.enabled).length;

  panel.querySelector("[data-pp-status]").classList.remove("error");
  panel.querySelector("[data-pp-status]").textContent = `${enabledCount} fontes ativas para pesquisa de mercado.`;
  current.innerHTML = `
    <strong>Fontes de pesquisa</strong>
    <p class="pp-market-muted">Desmarque fontes padrao ou acrescente novas. Use <code>{query}</code> na URL da busca personalizada.</p>
    <label>
      <span>CEP para cálculo de frete</span>
      <input data-pp-freight-zip inputmode="numeric" maxlength="9" placeholder="59000000" value="${escapeAttribute(freightConfig.cep || "")}">
    </label>
    <div class="pp-market-card-actions">
      <button type="button" class="pp-floating-secondary" data-pp-market-back>Voltar ao item</button>
      <button type="button" data-pp-save-sources>Salvar fontes</button>
      <button type="button" class="pp-floating-secondary" data-pp-reset-sources>Restaurar padrao</button>
    </div>
  `;

  results.innerHTML = `
    ${config.sources.map((source) => `
      <article class="pp-market-source-row" data-pp-source-id="${escapeAttribute(source.id)}">
        <input type="checkbox" data-pp-source-enabled ${source.enabled ? "checked" : ""}>
        <div>
          <strong>${escapeHtml(source.priority ? `${source.priority}. ${source.name}` : source.name)}</strong>
          <span class="pp-market-muted">${escapeHtml(source.searchUrlTemplate || "Fonte interna do scraper")}</span>
          ${source.custom ? `<span class="pp-market-muted">Fonte personalizada</span>` : ""}
        </div>
        ${source.custom ? `<button type="button" class="pp-floating-secondary" data-pp-remove-source="${escapeAttribute(source.id)}">Remover</button>` : ""}
      </article>
    `).join("")}
    <article class="pp-market-card">
      <h4>Adicionar fonte personalizada</h4>
      <label>
        <span>Nome da fonte</span>
        <input data-pp-new-source-name placeholder="Fornecedor regional">
      </label>
      <label>
        <span>URL de busca</span>
        <input data-pp-new-source-url placeholder="https://fornecedor.com.br/busca?q={query}">
      </label>
      <button type="button" data-pp-add-source>Adicionar fonte</button>
    </article>
  `;

  current.querySelector("[data-pp-market-back]").addEventListener("click", () => renderCurrentMarketView(panel));
  current.querySelector("[data-pp-save-sources]").addEventListener("click", () => saveMarketSourcesFromPanel(panel));
  current.querySelector("[data-pp-reset-sources]").addEventListener("click", async () => {
    await storageRemove("sync", MARKET_SOURCE_CONFIG_KEY);
    renderMarketSourcesConfig(panel);
  });
  results.querySelector("[data-pp-add-source]").addEventListener("click", () => addCustomMarketSource(panel));
  results.querySelectorAll("[data-pp-remove-source]").forEach((button) => {
    button.addEventListener("click", () => removeCustomMarketSource(panel, button.dataset.ppRemoveSource));
  });
}

async function saveMarketSourcesFromPanel(panel) {
  const config = await getMarketSourceConfig();
  const status = panel.querySelector("[data-pp-status]");
  const cep = normalizeFreightZip(panel.querySelector("[data-pp-freight-zip]")?.value || "");
  if (panel.querySelector("[data-pp-freight-zip]")?.value.trim() && !cep) {
    status.classList.add("error");
    status.textContent = "Informe um CEP válido com 8 dígitos.";
    return;
  }

  const enabledById = new Map(Array.from(panel.querySelectorAll("[data-pp-source-id]")).map((row) => {
    return [row.dataset.ppSourceId, Boolean(row.querySelector("[data-pp-source-enabled]")?.checked)];
  }));
  config.sources = config.sources.map((source) => ({
    ...source,
    enabled: enabledById.has(source.id) ? enabledById.get(source.id) : source.enabled
  }));
  await saveMarketSourceConfig(config);
  await saveMarketFreightConfig({ cep });
  renderMarketSourcesConfig(panel);
}

async function addCustomMarketSource(panel) {
  const name = panel.querySelector("[data-pp-new-source-name]")?.value.trim();
  const searchUrlTemplate = panel.querySelector("[data-pp-new-source-url]")?.value.trim();
  const status = panel.querySelector("[data-pp-status]");

  if (!name || !searchUrlTemplate || !searchUrlTemplate.includes("{query}")) {
    status.classList.add("error");
    status.textContent = "Informe nome e URL contendo {query}.";
    return;
  }

  const config = await getMarketSourceConfig();
  config.sources.push({
    id: `custom-${hashString(`${name}-${searchUrlTemplate}`)}`,
    name,
    searchUrlTemplate,
    enabled: true,
    priority: config.sources.length + 1,
    custom: true
  });
  await saveMarketSourceConfig(config);
  renderMarketSourcesConfig(panel);
}

async function removeCustomMarketSource(panel, sourceId) {
  const config = await getMarketSourceConfig();
  config.sources = config.sources.filter((source) => source.id !== sourceId || !source.custom);
  await saveMarketSourceConfig(config);
  renderMarketSourcesConfig(panel);
}

async function resetMarketSession(panel) {
  const confirmed = window.confirm("Reiniciar a sessão de pesquisa de mercado? Isso apaga itens, cotações aceitas, resultados e evidências salvas desta pesquisa.");
  if (!confirmed) {
    return;
  }

  const session = await getMarketSession();
  const screenshotIds = Object.values(session.items || {}).flatMap((item) => {
    return Object.values(item.cotacoes || {})
      .map((quote) => quote.screenshotId)
      .filter(Boolean);
  });
  const data = await storageGet("local", {
    marketSessions: {},
    marketScreenshots: {}
  });

  delete data.marketSessions[session.sessionId];
  screenshotIds.forEach((screenshotId) => {
    delete data.marketScreenshots[screenshotId];
  });

  await storageSet("local", {
    marketSessions: data.marketSessions,
    marketScreenshots: data.marketScreenshots
  });

  window.__ppMarketVisibleResultLimits = {};
  renderMarketHome(panel);
  await refreshMarketRowStatuses();
}

async function getEnabledMarketSources() {
  const config = await getMarketSourceConfig();
  return config.sources
    .filter((source) => source.enabled)
    .sort((left, right) => (left.priority || 999) - (right.priority || 999))
    .map((source) => ({
      id: source.id,
      name: source.name,
      searchUrlTemplate: source.searchUrlTemplate,
      custom: Boolean(source.custom)
    }));
}

function buildMarketProviderPayload(sources) {
  return sources.map((source) => {
    if (source.custom) {
      return {
        id: source.id,
        name: source.name,
        searchUrlTemplate: source.searchUrlTemplate,
        custom: true
      };
    }

    return source.id;
  });
}

async function getMarketSourceConfig() {
  const data = await storageGet("sync", { [MARKET_SOURCE_CONFIG_KEY]: null });
  const saved = data[MARKET_SOURCE_CONFIG_KEY];
  const savedSources = Array.isArray(saved?.sources) ? saved.sources : [];
  const canReuseBuiltInConfig = saved?.version === MARKET_SOURCE_CONFIG_VERSION;
  const savedById = canReuseBuiltInConfig
    ? new Map(savedSources.map((source) => [source.id, source]))
    : new Map();
  const defaultSources = DEFAULT_MARKET_SOURCES.map((source) => ({
    ...source,
    enabled: savedById.has(source.id) ? savedById.get(source.id).enabled !== false : source.enabled
  }));
  const customSources = savedSources
    .filter((source) => source.custom && source.name && source.searchUrlTemplate)
    .map((source, index) => ({
      ...source,
      priority: source.priority || defaultSources.length + index + 1,
      enabled: source.enabled !== false
    }));

  return { version: MARKET_SOURCE_CONFIG_VERSION, sources: [...defaultSources, ...customSources] };
}

async function saveMarketSourceConfig(config) {
  await storageSet("sync", {
    [MARKET_SOURCE_CONFIG_KEY]: {
      ...config,
      version: MARKET_SOURCE_CONFIG_VERSION
    }
  });
}

async function getMarketFreightConfig() {
  const data = await storageGet("sync", { [MARKET_FREIGHT_CONFIG_KEY]: null });
  const saved = data[MARKET_FREIGHT_CONFIG_KEY] || {};
  return {
    cep: normalizeFreightZip(saved.cep || "")
  };
}

async function saveMarketFreightConfig(config) {
  await storageSet("sync", {
    [MARKET_FREIGHT_CONFIG_KEY]: {
      cep: normalizeFreightZip(config?.cep || "")
    }
  });
}

function normalizeFreightZip(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 8 ? digits : "";
}

function queueMarketPrefetch(item) {
  if (!extensionContextAlive) {
    return;
  }

  if (!item?.itemKey) {
    return;
  }

  if (Date.now() < (window.__ppMarketPrefetchDisabledUntil || 0)) {
    return;
  }

  window.__ppMarketPrefetchQueue ||= [];
  window.__ppMarketPrefetchQueuedKeys ||= new Set();

  if (window.__ppMarketPrefetchQueuedKeys.has(item.itemKey) || window.__ppMarketPrefetchQueue.length >= MARKET_PREFETCH_MAX_QUEUE) {
    return;
  }

  window.__ppMarketPrefetchQueuedKeys.add(item.itemKey);
  window.__ppMarketPrefetchQueue.push(item);
  processMarketPrefetchQueue();
}

async function processMarketPrefetchQueue() {
  if (!extensionContextAlive) {
    return;
  }

  if (window.__ppMarketPrefetchRunning) {
    return;
  }

  window.__ppMarketPrefetchRunning = true;
  try {
    while (window.__ppMarketPrefetchQueue?.length) {
      if (!extensionContextAlive) {
        return;
      }
      const item = window.__ppMarketPrefetchQueue.shift();
      window.__ppMarketPrefetchQueuedKeys.delete(item.itemKey);
      try {
        await prefetchMarketItem(item);
      } catch (error) {
        handleExtensionAsyncError(error);
      }
      await sleep(350);
    }
  } finally {
    window.__ppMarketPrefetchRunning = false;
  }
}

async function prefetchMarketItem(item) {
  if (!extensionContextAlive) {
    return;
  }

  const session = await getMarketSession();
  const storedItem = session.items[item.itemKey];
  if (storedItem?.lastResults?.length) {
    return;
  }

  const config = await getMarketBackendConfig();
  const sources = await getEnabledMarketSources();
  if (!sources.length) {
    return;
  }

  session.items[item.itemKey] = {
    ...item,
    ...storedItem,
    itemKey: item.itemKey,
    numero: item.numero,
    descricao: item.descricao,
    termoBusca: storedItem?.termoBusca || item.termoBusca,
    status: storedItem?.status || "pre-busca"
  };
  await saveMarketSession(session);

  const response = await sendRuntimeMessage({
    type: "PP_MARKET_SEARCH",
    payload: {
      endpoint: config.marketSearchEndpoint || DEFAULT_MARKET_SEARCH_ENDPOINT,
      token: config.marketSearchToken,
      query: session.items[item.itemKey].termoBusca,
      itemId: item.itemKey,
      pesquisaId: session.pesquisaId,
      providers: buildMarketProviderPayload(sources),
      itemContext: {
        numero: item.numero,
        description: item.descricao,
        originalDescription: item.originalDescription || item.descricao,
        catalogCode: item.catalogCode || extractCatalogCodeFromDescription(item.descricao)
      },
      prefetch: true
    }
  });

  const latestSession = await getMarketSession();
  const latestItem = latestSession.items[item.itemKey] || session.items[item.itemKey];
  if (!response.ok) {
    latestItem.prefetchError = response.message || "Pre-busca falhou.";
    latestSession.items[item.itemKey] = latestItem;
    await saveMarketSession(latestSession);
    if (/servico local|failed to fetch|conectar/i.test(latestItem.prefetchError)) {
      window.__ppMarketPrefetchDisabledUntil = Date.now() + MARKET_PREFETCH_DISABLED_MS;
    }
    return;
  }

  latestItem.lastResults = response.results || [];
  latestItem.status = "pre-buscado";
  latestItem.prefetchError = "";
  latestItem.resultCacheVersion = MARKET_RESULT_CACHE_VERSION;
  latestItem.catalogMatch = response.enrichment?.catalogMatch || latestItem.catalogMatch || null;
  latestItem.canonicalDescription = response.enrichment?.canonicalDescription || latestItem.canonicalDescription || latestItem.descricao;
  latestItem.queryPrimary = response.enrichment?.queryPrimary || latestItem.queryPrimary || latestItem.termoBusca;
  latestItem.querySignals = response.enrichment?.querySignals || latestItem.querySignals || {};
  latestSession.items[item.itemKey] = latestItem;
  await saveMarketSession(latestSession);
  await refreshMarketRowStatuses();
}

async function getMarketSession() {
  assertExtensionContext();
  const pesquisaId = detectPesquisaId();
  const sessionId = `market-${pesquisaId}`;
  const data = await storageGet("local", { marketSessions: {} });
  const session = data.marketSessions[sessionId] || {
    sessionId,
    pesquisaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: {}
  };
  return session;
}

async function saveMarketSession(session) {
  assertExtensionContext();
  session.updatedAt = new Date().toISOString();
  const data = await storageGet("local", { marketSessions: {} });
  data.marketSessions[session.sessionId] = session;
  await storageSet("local", { marketSessions: data.marketSessions });
}

async function upsertMarketItem(item) {
  const session = await getMarketSession();
  session.items[item.itemKey] = {
    ...item,
    ...session.items[item.itemKey],
    itemKey: item.itemKey,
    numero: item.numero,
    descricao: item.descricao,
    originalDescription: item.originalDescription || item.descricao,
    catalogCode: item.catalogCode || extractCatalogCodeFromDescription(item.descricao),
    quantidade: item.quantidade,
    unidade: item.unidade,
    media: item.media,
    mediana: item.mediana,
    termoBusca: session.items[item.itemKey]?.termoBusca || item.termoBusca
  };
  await saveMarketSession(session);
  return session.items[item.itemKey];
}

function detectPesquisaId() {
  const bodyText = cleanText(document.body.innerText || "");
  const match = bodyText.match(/Numero da pesquisa\s+(\d+\s*\/\s*\d+)/i) ||
    bodyText.match(/N[uú]mero da pesquisa\s+(\d+\s*\/\s*\d+)/i);
  if (match) {
    return match[1].replace(/\s/g, "");
  }

  const urlMatch = location.href.match(/(\d{4,})/);
  return urlMatch ? urlMatch[1] : "pesquisa-local";
}

async function refreshMarketRowStatuses() {
  if (!extensionContextAlive) {
    return;
  }

  const table = document.querySelector(".tabela-itens p-table, .tabela-itens table") || document.querySelector(".tabela-itens");
  if (!table) {
    return;
  }
  table.querySelectorAll("tbody.p-datatable-tbody tr, tbody tr").forEach((row) => {
    refreshMarketRowStatus(row).catch(handleExtensionAsyncError);
  });
}

async function refreshMarketRowStatus(row) {
  if (!extensionContextAlive) {
    return;
  }

  const item = parseMarketItemRow(row);
  if (!item) {
    return;
  }

  const actionsCell = getMarketRowCells(row).at(-1);
  let badge = actionsCell.querySelector(`.${MARKET_STATUS_CLASS}`);
  if (!badge) {
    badge = document.createElement("span");
    badge.className = MARKET_STATUS_CLASS;
    actionsCell.append(badge);
  }

  const session = await getMarketSession();
  const storedItem = session.items[item.itemKey];
  const count = storedItem ? Object.values(storedItem.cotacoes || {}).filter((quote) => quote.status === "accepted").length : 0;
  const resultCount = storedItem ? filterRenderableMarketResults(storedItem.lastResults || [], storedItem).length : 0;
  badge.textContent = storedItem
    ? `${count}/3${resultCount ? ` • ${resultCount} res` : ""}`
    : "pendente";
}

function assertExtensionContext() {
  if (!extensionContextAlive || !chrome?.runtime?.id) {
    markExtensionContextInvalidated();
  }
}

function handleExtensionAsyncError(error) {
  if (isExtensionContextInvalidatedError(error)) {
    markExtensionContextInvalidated({ throwError: false });
    return;
  }

  console.warn("[Pesquisa de Precos] Falha assíncrona no content script:", error);
}

async function storageGet(areaName, defaults) {
  const area = getStorageArea(areaName);
  return area.get(defaults);
}

async function storageSet(areaName, values) {
  const area = getStorageArea(areaName);
  return area.set(values);
}

async function storageRemove(areaName, keys) {
  const area = getStorageArea(areaName);
  if (!area.remove) {
    return;
  }

  return area.remove(keys);
}

function getStorageArea(areaName) {
  const storage = typeof chrome === "undefined" ? null : chrome.storage;
  const area = storage?.[areaName] || storage?.local;
  if (!area?.get || !area?.set) {
    throw new Error("Storage da extensao indisponivel. Recarregue a extensao e a pagina do SERPRO.");
  }

  return area;
}

function isExtensionContextInvalidatedError(error) {
  return /extension context invalidated/i.test(error?.message || String(error || ""));
}

function markExtensionContextInvalidated(options = {}) {
  extensionContextAlive = false;
  stopMarketAutomation();
  showExtensionReloadNotice();
  if (options.throwError !== false) {
    throw new Error("Extension context invalidated");
  }
}

function showExtensionReloadNotice() {
  if (document.querySelector("#pp-extension-reload-notice")) {
    return;
  }

  const notice = document.createElement("div");
  notice.id = "pp-extension-reload-notice";
  notice.textContent = "A extensao foi recarregada. Recarregue esta pagina do SERPRO para continuar usando a pesquisa de mercado.";
  notice.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "max-width:360px",
    "padding:12px 14px",
    "border:1px solid #f59e0b",
    "border-radius:8px",
    "background:#fff7ed",
    "color:#7c2d12",
    "font:14px/1.35 Segoe UI,Tahoma,sans-serif",
    "box-shadow:0 12px 28px rgba(15,23,42,.18)"
  ].join(";");
  document.documentElement.append(notice);
}

function stopMarketAutomation() {
  window.__ppMarketItemObserver?.disconnect?.();
  window.__ppMarketItemObserver = null;
  window.clearTimeout(window.__ppMarketItemObserverTimer);
  window.__ppMarketPrefetchQueue = [];
  window.__ppMarketPrefetchQueuedKeys?.clear?.();
  window.__ppMarketPrefetchRunning = false;
}

function createQuoteId(url) {
  return `quote-${hashString(url)}`;
}

function getQuantityInfo(item) {
  const quantity = parseMoney(item?.quantidade);
  if (quantity !== null && quantity > 0) {
    return { quantity, warning: "" };
  }

  return {
    quantity: 1,
    warning: "Quantidade inválida ou ausente; cálculo de frete usou 1 unidade."
  };
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

async function saveScreenshot(dataUrl) {
  const id = `shot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const data = await storageGet("local", { marketScreenshots: {} });
  data.marketScreenshots[id] = dataUrl;
  await storageSet("local", { marketScreenshots: data.marketScreenshots });
  return id;
}

async function exportMarketSession() {
  const session = await getMarketSession();
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${session.sessionId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importMarketSession() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const session = JSON.parse(await file.text());
    if (!session.sessionId || !session.items) {
      throw new Error("Arquivo de sessão inválido.");
    }
    await saveMarketSession(session);
    const panel = document.querySelector("#pp-compor-floating-panel");
    if (panel) {
      await renderMarketSession(panel);
    }
    await refreshMarketRowStatuses();
  });
  input.click();
}

async function openMarketReport() {
  const session = await getMarketSession();
  await saveMarketSession(session);
  await sendRuntimeMessage({
    type: "PP_MARKET_OPEN_REPORT",
    payload: { sessionId: session.sessionId }
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, message: "Sem resposta da extensao." });
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function findComporControl(cell) {
  return getComporControl(cell)?.target || null;
}

function getComporControl(cell) {
  if (!cell) {
    return null;
  }

  const selector = [
    ".br-switch",
    ".custom-switch",
    ".form-switch",
    ".switch",
    ".toggle",
    "[class*='switch']",
    "[class*='toggle']",
    "button[role='switch']",
    "[role='switch']",
    ".mat-slide-toggle",
    ".mat-mdc-slide-toggle",
    ".p-inputswitch",
    ".p-inputswitch-slider",
    "input[type='checkbox']"
  ].join(",");

  const candidates = Array.from(cell.querySelectorAll(selector));
  const input = cell.querySelector("input[type='checkbox']");
  const roleSwitch = cell.querySelector("[role='switch']");
  const container = findSwitchContainer(input || roleSwitch || candidates[0], cell);
  const target = findClickTarget({ cell, input, roleSwitch, container, fallback: candidates[0] });

  if (!target) {
    return null;
  }

  return {
    target,
    checked: isChecked({ cell, input, roleSwitch, container, target })
  };
}

function findSwitchContainer(element, cell) {
  if (!element) {
    return null;
  }

  return element.closest?.(
    [
      ".br-switch",
      ".custom-switch",
      ".form-switch",
      ".switch",
      ".toggle",
      "[class*='switch']",
      "[class*='toggle']",
      ".mat-slide-toggle",
      ".mat-mdc-slide-toggle",
      ".p-inputswitch"
    ].join(",")
  ) || cell;
}

function findClickTarget({ cell, input, roleSwitch, container, fallback }) {
  if (input?.id) {
    const label = cell.querySelector(`label[for="${escapeSelector(input.id)}"]`);
    if (label) {
      return label;
    }
  }

  if (roleSwitch) {
    return roleSwitch;
  }

  if (input) {
    return input.closest("label") || container || input;
  }

  return container || fallback || null;
}

function isChecked({ cell, input, roleSwitch, container, target }) {
  const modelOwner = target.closest?.("br-switch, [ng-reflect-model], [ng-reflect-checked], [ng-reflect-is-checked]") ||
    container?.closest?.("br-switch, [ng-reflect-model], [ng-reflect-checked], [ng-reflect-is-checked]");
  const reflectedState = readReflectedBoolean(modelOwner);
  if (reflectedState !== null) {
    return reflectedState;
  }

  if (input) {
    return input.checked || input.hasAttribute("checked");
  }

  const ariaOwner = roleSwitch || target || container;
  const ariaChecked = ariaOwner?.getAttribute?.("aria-checked");
  if (ariaChecked !== null && ariaChecked !== undefined) {
    return ariaChecked === "true";
  }

  const ariaPressed = ariaOwner?.getAttribute?.("aria-pressed");
  if (ariaPressed !== null && ariaPressed !== undefined) {
    return ariaPressed === "true";
  }

  const stateOwner = container || target || cell;
  const stateText = [
    stateOwner.className,
    target?.className,
    cell.className
  ].join(" ").toLowerCase();

  if (/\b(unchecked|disabled|off|false)\b/.test(stateText)) {
    return false;
  }

  if (/\b(checked|active|selected|on|ligado)\b/.test(stateText)) {
    return true;
  }

  return looksVisuallyChecked(stateOwner || target);
}

function readReflectedBoolean(element) {
  if (!element) {
    return null;
  }

  for (const attribute of ["ng-reflect-model", "ng-reflect-checked", "ng-reflect-is-checked"]) {
    const value = element.getAttribute(attribute);
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }

  return null;
}

function clickControl(target) {
  target.scrollIntoView({ block: "center", inline: "nearest" });
  target.click();
}

function looksVisuallyChecked(element) {
  if (!element) {
    return false;
  }

  const switchRect = element.getBoundingClientRect();
  const possibleKnobs = Array.from(element.querySelectorAll("span, label, button, div"))
    .filter((candidate) => candidate !== element)
    .map((candidate) => candidate.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0 && rect.width <= switchRect.width * 0.8);

  if (!switchRect.width || !possibleKnobs.length) {
    return false;
  }

  return possibleKnobs.some((rect) => {
    const knobCenter = rect.left + rect.width / 2;
    const switchCenter = switchRect.left + switchRect.width / 2;
    return knobCenter > switchCenter;
  });
}

function escapeSelector(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function parseMoney(value) {
  if (!value) {
    return null;
  }

  const cleaned = String(value)
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!cleaned) {
    return null;
  }

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoneyValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(number);
}

function formatRuleCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(number);
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return parseMoney(value);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ensurePreviewStyle() {
  if (document.querySelector("#pp-compor-preview-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "pp-compor-preview-style";
  style.textContent = `
    .${ROW_HIGHLIGHT_CLASS} {
      outline: 2px solid #f39c12 !important;
      outline-offset: -2px !important;
      background: #fff4d6 !important;
    }
  `;
  document.documentElement.append(style);
}

function clearPreview() {
  document.querySelectorAll(`.${ROW_HIGHLIGHT_CLASS}`).forEach((element) => {
    element.classList.remove(ROW_HIGHLIGHT_CLASS);
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function waitFor(callback, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const tick = () => {
      const result = callback();
      if (result) {
        resolve(result);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null);
        return;
      }

      window.setTimeout(tick, 100);
    };

    tick();
  });
}
})();
