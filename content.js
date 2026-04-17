(() => {
const EXTENSION_SCRIPT_VERSION = "1.0.7";

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
const DELETE_REASON_LOW = {
  option: "valor inexequivel",
  justification: "Preco abaixo do minimo configurado."
};
const DELETE_REASON_HIGH = {
  option: "valor excessivamente elevado",
  justification: "Preco acima do maximo configurado."
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PP_RUN_COMPOR_RULE_V2" && message?.type !== "PP_UNDO_COMPOR_RULE_V2" && message?.type !== "PP_SHOW_FLOATING_PANEL_V2") {
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

function getMessageTask(message) {
  if (message.type === "PP_UNDO_COMPOR_RULE_V2") {
    return undoLastRun();
  }

  if (message.type === "PP_SHOW_FLOATING_PANEL_V2") {
    showFloatingPanel(message.settings);
    return Promise.resolve({ shown: true });
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

    if (!matchesRule(price, config)) {
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
    missingControl
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
  const initialRows = findRows().filter((row) => config.scanAllPages || isVisible(row.element));
  const initialSummary = summarizeDeleteCandidates(initialRows, config);

  let changed = 0;
  let missingDeleteButton = 0;
  let modalErrors = 0;
  const skippedRows = new Set();

  for (let attempt = 0; attempt < initialSummary.matched; attempt += 1) {
    const candidate = findNextDeleteCandidate(config, skippedRows);
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
    scanned: initialSummary.scanned,
    matched: initialSummary.matched,
    changed,
    missingDeleteButton,
    modalErrors
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
  const mode = settings?.mode || "between";
  const min = parseDecimal(settings?.minPrice);
  const max = parseDecimal(settings?.maxPrice);

  return {
    mode,
    min,
    max,
    inclusive: Boolean(settings?.inclusive),
    scanAllPages: settings?.scanAllPages !== false
  };
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
  const aboveMin = config.inclusive ? price >= config.min : price > config.min;
  const belowMax = config.inclusive ? price <= config.max : price < config.max;

  if (config.mode === "above") {
    return aboveMin;
  }

  if (config.mode === "below") {
    return belowMax;
  }

  if (config.mode === "outside") {
    const belowMin = config.inclusive ? price < config.min : price <= config.min;
    const aboveMax = config.inclusive ? price > config.max : price >= config.max;
    return belowMin || aboveMax;
  }

  return aboveMin && belowMax;
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

  const existing = document.querySelector("#pp-compor-floating-panel");
  if (existing) {
    existing.style.display = "block";
    existing.querySelector("[data-pp-status]").textContent = "Painel pronto.";
    return;
  }

  const settings = {
    mode: initialSettings?.mode || "between",
    minPrice: initialSettings?.minPrice || "50",
    maxPrice: initialSettings?.maxPrice || "100",
    inclusive: Boolean(initialSettings?.inclusive),
    scanAllPages: initialSettings?.scanAllPages !== false
  };

  const panel = document.createElement("div");
  panel.id = "pp-compor-floating-panel";
  panel.innerHTML = `
    <div class="pp-floating-header" data-pp-drag>
      <strong>Pesquisa de Precos</strong>
      <button type="button" data-pp-close aria-label="Fechar painel">x</button>
    </div>
    <div class="pp-floating-body">
      <label>
        <span>Criterio para desmarcar</span>
        <select data-pp-mode>
          <option value="between">Preco dentro da faixa</option>
          <option value="outside">Preco fora da faixa</option>
          <option value="above">Preco acima do minimo</option>
          <option value="below">Preco abaixo do maximo</option>
        </select>
      </label>
      <div class="pp-floating-grid">
        <label>
          <span>Minimo</span>
          <input data-pp-min type="text" inputmode="decimal">
        </label>
        <label>
          <span>Maximo</span>
          <input data-pp-max type="text" inputmode="decimal">
        </label>
      </div>
      <label class="pp-floating-check">
        <input data-pp-inclusive type="checkbox">
        <span>Incluir iguais ao desmarcar</span>
      </label>
      <label class="pp-floating-check">
        <input data-pp-scan-all type="checkbox">
        <span>Processar linhas carregadas</span>
      </label>
      <div class="pp-floating-actions">
        <button type="button" data-pp-action="preview">Pre-visualizar</button>
        <button type="button" data-pp-action="apply">Desmarcar</button>
      </div>
      <button type="button" class="pp-floating-secondary" data-pp-action="undo">Desfazer desmarcar</button>
      <button type="button" class="pp-floating-danger" data-pp-action="delete">Excluir abaixo/acima</button>
      <div class="pp-floating-status" data-pp-status>Painel pronto.</div>
    </div>
  `;

  document.documentElement.append(panel);

  panel.querySelector("[data-pp-mode]").value = settings.mode;
  panel.querySelector("[data-pp-min]").value = settings.minPrice;
  panel.querySelector("[data-pp-max]").value = settings.maxPrice;
  panel.querySelector("[data-pp-inclusive]").checked = settings.inclusive;
  panel.querySelector("[data-pp-scan-all]").checked = settings.scanAllPages;

  panel.querySelector("[data-pp-close]").addEventListener("click", () => {
    panel.style.display = "none";
  });

  panel.querySelectorAll("[data-pp-action]").forEach((button) => {
    button.addEventListener("click", () => runFloatingAction(panel, button.dataset.ppAction));
  });

  makeFloatingPanelDraggable(panel);
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
  } catch (error) {
    status.classList.add("error");
    status.textContent = error instanceof Error ? error.message : "Erro inesperado.";
  }
}

function readFloatingSettings(panel) {
  return {
    mode: panel.querySelector("[data-pp-mode]").value,
    minPrice: panel.querySelector("[data-pp-min]").value.trim(),
    maxPrice: panel.querySelector("[data-pp-max]").value.trim(),
    inclusive: panel.querySelector("[data-pp-inclusive]").checked,
    scanAllPages: panel.querySelector("[data-pp-scan-all]").checked
  };
}

function validateFloatingSettings(settings, action) {
  const needsMin = action === "delete" || settings.mode !== "below";
  const needsMax = action === "delete" || settings.mode !== "above";
  const min = parseDecimal(settings.minPrice);
  const max = parseDecimal(settings.maxPrice);

  if (needsMin && min === null) {
    return "Informe um minimo valido.";
  }

  if (needsMax && max === null) {
    return "Informe um maximo valido.";
  }

  if (needsMin && needsMax && min > max) {
    return "O minimo nao pode ser maior que o maximo.";
  }

  return "";
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
      width: 340px;
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
      width: 28px;
      height: 28px;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 999px;
      background: transparent;
      color: #ffffff;
      cursor: pointer;
    }
    #pp-compor-floating-panel .pp-floating-body {
      display: grid;
      gap: 10px;
      padding: 12px;
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
  `;
  document.documentElement.append(style);
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
