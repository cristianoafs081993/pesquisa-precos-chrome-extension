const DEFAULTS = {
  mode: "between",
  minPrice: "50",
  maxPrice: "100",
  inclusive: false,
  scanAllPages: true
};

const fields = {
  mode: document.querySelector("#mode"),
  minPrice: document.querySelector("#minPrice"),
  maxPrice: document.querySelector("#maxPrice"),
  inclusive: document.querySelector("#inclusive"),
  scanAllPages: document.querySelector("#scanAllPages"),
  floatingPanel: document.querySelector("#floatingPanel"),
  preview: document.querySelector("#preview"),
  apply: document.querySelector("#apply"),
  delete: document.querySelector("#delete"),
  undo: document.querySelector("#undo"),
  status: document.querySelector("#status")
};

loadSettings();
fields.preview.addEventListener("click", () => run("preview"));
fields.apply.addEventListener("click", () => run("apply"));
fields.delete.addEventListener("click", () => run("delete"));
fields.undo.addEventListener("click", undoLastRun);
fields.floatingPanel.addEventListener("click", showFloatingPanel);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  fields.mode.value = settings.mode;
  fields.minPrice.value = settings.minPrice;
  fields.maxPrice.value = settings.maxPrice;
  fields.inclusive.checked = settings.inclusive;
  fields.scanAllPages.checked = settings.scanAllPages;
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
  await chrome.storage.sync.set(settings);

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

  const settings = readSettings();
  const validation = validate(settings, action);
  if (validation) {
    setStatus(validation, true);
    return;
  }

  await chrome.storage.sync.set(settings);

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

async function getActiveSerproTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("Nao foi possivel acessar a aba atual.", true);
    return null;
  }

  if (!tab.url?.startsWith("https://pesqpreco.estaleiro.serpro.gov.br/")) {
    setStatus("Abra uma pagina do Pesquisa de Precos do SERPRO antes de usar a extensao.", true);
    return null;
  }

  return tab;
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

function readSettings() {
  return {
    mode: fields.mode.value,
    minPrice: fields.minPrice.value.trim(),
    maxPrice: fields.maxPrice.value.trim(),
    inclusive: fields.inclusive.checked,
    scanAllPages: fields.scanAllPages.checked
  };
}

function validate(settings, action) {
  const needsMin = action === "delete" || settings.mode !== "below";
  const needsMax = action === "delete" || settings.mode !== "above";
  const min = parseDecimal(settings.minPrice);
  const max = parseDecimal(settings.maxPrice);

  if (needsMin && min === null) {
    return "Informe um valor minimo valido.";
  }

  if (needsMax && max === null) {
    return "Informe um valor maximo valido.";
  }

  if (needsMin && needsMax && min > max) {
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
