const DEFAULTS = {
  mode: "outside",
  minPrice: "50",
  maxPrice: "100",
  autoRange: true
};

const fields = {
  autoRange: document.querySelector("#autoRange"),
  minPrice: document.querySelector("#minPrice"),
  maxPrice: document.querySelector("#maxPrice"),
  floatingPanel: document.querySelector("#floatingPanel"),
  preview: document.querySelector("#preview"),
  apply: document.querySelector("#apply"),
  delete: document.querySelector("#delete"),
  undo: document.querySelector("#undo"),
  rangeSummary: document.querySelector("#rangeSummary"),
  status: document.querySelector("#status")
};

const sourceTabId = Number(new URLSearchParams(window.location.search).get("sourceTabId"));
let lastRangeRefresh = 0;

loadSettings();
fields.preview.addEventListener("click", () => run("preview"));
fields.apply.addEventListener("click", () => run("apply"));
fields.delete.addEventListener("click", () => run("delete"));
fields.undo.addEventListener("click", undoLastRun);
fields.floatingPanel.addEventListener("click", showFloatingPanel);
fields.autoRange.addEventListener("change", updateRangeMode);
window.setInterval(() => {
  if (fields.autoRange.checked) {
    refreshCalculatedRange(false);
  }
}, 1500);

async function loadSettings() {
  const settings = await storageGet("sync", DEFAULTS);
  fields.autoRange.checked = settings.autoRange !== false;
  fields.minPrice.value = settings.minPrice;
  fields.maxPrice.value = settings.maxPrice;
  updateRangeMode();
}

async function undoLastRun() {
  setStatus("Desfazendo ultima aplicacao...");

  const tab = await getActiveSerproTab();
  if (!tab) {
    return;
  }

  try {
    await ensureContentScript(tab.id);
  } catch (_error) {
    setStatus("Nao foi possivel preparar a extensao nesta aba. Recarregue a pagina e tente novamente.", true);
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "PP_UNDO_COMPOR_RULE_V2" }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      setStatus("Abra a pagina da pesquisa e recarregue antes de usar a extensao.", true);
      return;
    }

    if (!response?.ok) {
      setStatus(response?.message || "Nao foi possivel desfazer.", true);
      return;
    }

    const extras = [];
    if (response.alreadyChecked) {
      extras.push(`${response.alreadyChecked} ja estavam marcadas`);
    }
    if (response.missingControl) {
      extras.push(`${response.missingControl} sem controle detectado`);
    }

    const suffix = extras.length ? ` (${extras.join(", ")}).` : ".";
    setStatus(`${response.changed} linhas remarcadas${suffix}`);
  });
}

async function showFloatingPanel() {
  setStatus("Abrindo painel flutuante...");

  const settings = readSettings();
  await storageSet("sync", settings);

  const tab = await getActiveSerproTab();
  if (!tab) {
    return;
  }

  try {
    await ensureContentScript(tab.id);
  } catch (_error) {
    setStatus("Nao foi possivel preparar a extensao nesta aba. Recarregue a pagina e tente novamente.", true);
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "PP_SHOW_FLOATING_PANEL_V2", settings }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      setStatus("Nao foi possivel abrir o painel flutuante.", true);
      return;
    }

    window.close();
  });
}

async function run(action) {
  const statusByAction = {
    preview: "Analisando linhas...",
    apply: "Desmarcando Compor linha a linha...",
    delete: "Excluindo itens abaixo/acima dos limites, um por vez..."
  };
  setStatus(statusByAction[action] || "Executando...");

  if (fields.autoRange.checked) {
    await refreshCalculatedRange(true);
  }
  const settings = readSettings();
  const validation = validate(settings, action);
  if (validation) {
    setStatus(validation, true);
    return;
  }

  await storageSet("sync", settings);

  const tab = await getActiveSerproTab();
  if (!tab) {
    return;
  }

  try {
    await ensureContentScript(tab.id);
  } catch (_error) {
    setStatus("Nao foi possivel preparar a extensao nesta aba. Recarregue a pagina e tente novamente.", true);
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "PP_RUN_COMPOR_RULE_V2", action, settings }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      setStatus("Abra a pagina da pesquisa e recarregue antes de usar a extensao.", true);
      return;
    }

    if (!response?.ok) {
      setStatus(response?.message || "Nao foi possivel executar a regra.", true);
      return;
    }

    if (action === "preview") {
      setStatus(`${response.matched} linhas encontradas. ${response.scanned} linhas analisadas.`);
      return;
    }

    if (action === "delete") {
      const extras = [];
      if (response.missingDeleteButton) {
        extras.push(`${response.missingDeleteButton} sem botao de excluir`);
      }
      if (response.modalErrors) {
        extras.push(`${response.modalErrors} com erro no popup`);
      }

      const suffix = extras.length ? ` (${extras.join(", ")}).` : ".";
      setStatus(`${response.matched} linhas abaixo/acima dos limites; ${response.changed} excluidas. ${response.scanned} linhas analisadas${suffix}`);
      return;
    }

    const extras = [];
    if (response.alreadyUnchecked) {
      extras.push(`${response.alreadyUnchecked} ja estavam desmarcadas`);
    }
    if (response.missingControl) {
      extras.push(`${response.missingControl} sem controle detectado`);
    }

    const suffix = extras.length ? ` (${extras.join(", ")}).` : ".";
    setStatus(`${response.matched} linhas encontradas; ${response.changed} linhas desmarcadas. ${response.scanned} linhas analisadas${suffix}`);
  });
}

async function refreshCalculatedRange(showErrors) {
  if (!fields.autoRange.checked) {
    return;
  }

  if (!showErrors && Date.now() - lastRangeRefresh < 1000) {
    return;
  }
  lastRangeRefresh = Date.now();

  try {
    const tab = await getActiveSerproTab();
    if (!tab) {
      return;
    }

    await ensureContentScript(tab.id);
    const response = await sendContentMessage(tab.id, { type: "PP_GET_COMPOR_RANGE_V2" });
    if (!response?.ok || !response.range) {
      throw new Error(response?.message || "Nao foi possivel calcular a faixa.");
    }

    renderCalculatedRange(response.range);
  } catch (error) {
    fields.minPrice.value = "";
    fields.maxPrice.value = "";
    fields.rangeSummary.textContent = "Nao consegui ler a media/mediana selecionada na pagina.";
    if (showErrors) {
      setStatus(error instanceof Error ? error.message : "Nao foi possivel calcular a faixa.", true);
    }
  }
}

function renderCalculatedRange(range) {
  fields.minPrice.value = range.minFormatted || "";
  fields.maxPrice.value = range.maxFormatted || "";
  fields.rangeSummary.textContent = `${range.basisLabel}: ${range.valueFormatted}. Faixa normativa: ${range.minFormatted} a ${range.maxFormatted}.`;
}

function updateRangeMode() {
  const automatic = fields.autoRange.checked;
  fields.minPrice.readOnly = automatic;
  fields.maxPrice.readOnly = automatic;

  if (automatic) {
    fields.rangeSummary.textContent = "Faixa calculada pela media/mediana selecionada na pagina.";
    refreshCalculatedRange(false);
    return;
  }

  fields.rangeSummary.textContent = "Faixa manual informada pelo usuario.";
}

async function getActiveSerproTab() {
  if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
    const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
    if (!sourceTab?.id) {
      setStatus("A aba original nao esta mais disponivel.", true);
      return null;
    }

    if (!isSerproTab(sourceTab)) {
      setStatus("Abra uma pagina do Pesquisa de Precos do SERPRO antes de usar a extensao.", true);
      return null;
    }

    return sourceTab;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("Nao foi possivel acessar a aba atual.", true);
    return null;
  }

  if (!isSerproTab(tab)) {
    setStatus("Abra uma pagina do Pesquisa de Precos do SERPRO antes de usar a extensao.", true);
    return null;
  }

  return tab;
}

function isSerproTab(tab) {
  return tab?.url?.startsWith("https://pesqpreco.estaleiro.serpro.gov.br/");
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

function sendContentMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, message: error.message });
        return;
      }

      resolve(response);
    });
  });
}

async function storageGet(areaName, defaults) {
  const area = getStorageArea(areaName);
  return area.get(defaults);
}

async function storageSet(areaName, values) {
  const area = getStorageArea(areaName);
  return area.set(values);
}

function getStorageArea(areaName) {
  const storage = typeof chrome === "undefined" ? null : chrome.storage;
  const area = storage?.[areaName] || storage?.local;
  if (!area?.get || !area?.set) {
    throw new Error("Storage da extensao indisponivel. Recarregue a extensao em chrome://extensions.");
  }

  return area;
}

function readSettings() {
  const settings = {
    mode: "outside",
    dynamicRange: fields.autoRange.checked,
    autoRange: fields.autoRange.checked,
    scanAllPages: true
  };

  if (!fields.autoRange.checked) {
    settings.minPrice = fields.minPrice.value.trim();
    settings.maxPrice = fields.maxPrice.value.trim();
  }

  return settings;
}

function validate(settings, action) {
  if (settings.dynamicRange) {
    return "";
  }

  const min = parseDecimal(settings.minPrice);
  const max = parseDecimal(settings.maxPrice);

  if (min === null) {
    return "Informe um valor minimo valido.";
  }

  if (max === null) {
    return "Informe um valor maximo valido.";
  }

  if (min > max) {
    return "O minimo nao pode ser maior que o maximo.";
  }

  return "";
}

function parseDecimal(value) {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function setStatus(message, isError = false) {
  fields.status.textContent = message;
  fields.status.classList.toggle("error", isError);
}
