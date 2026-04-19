chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith("PP_MARKET_")) {
    return false;
  }

  handleMarketMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Erro inesperado."
      });
    });

  return true;
});

async function handleMarketMessage(message) {
  if (message.type === "PP_MARKET_SEARCH") {
    return searchMarket(message.payload);
  }

  if (message.type === "PP_MARKET_CAPTURE") {
    return captureEvidence(message.payload);
  }

  if (message.type === "PP_MARKET_OPEN_URL") {
    await chrome.tabs.create({ url: message.payload.url, active: true });
    return {};
  }

  if (message.type === "PP_MARKET_OPEN_REPORT") {
    const url = chrome.runtime.getURL(`report.html?sessionId=${encodeURIComponent(message.payload.sessionId)}`);
    await chrome.tabs.create({ url, active: true });
    return {};
  }

  throw new Error("Mensagem nao suportada.");
}

async function searchMarket(payload) {
  const endpoint = String(payload?.endpoint || "").trim();
  const query = String(payload?.query || "").trim();

  if (!endpoint) {
    throw new Error("Configure a URL do backend de busca no painel.");
  }

  if (!query) {
    throw new Error("Informe um termo de busca.");
  }

  const headers = { "Content-Type": "application/json" };
  const token = String(payload?.token || "").trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["x-api-key"] = token;
  }

  // O background service worker faz a ponte entre a pagina do SERPRO e o
  // scraper local. Isso evita depender do contexto/origem da pagina injetada.
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        itemId: payload?.itemId || null,
        pesquisaId: payload?.pesquisaId || null
      })
    });
  } catch (error) {
    if (/localhost|127\.0\.0\.1/i.test(endpoint)) {
      throw new Error("Nao foi possivel conectar ao servico local. Execute `npm start` em scraper-service e tente novamente.");
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Busca falhou (${response.status})${detail ? `: ${detail.slice(0, 240)}` : "."}`);
  }

  const data = await response.json();
  return { results: normalizeSearchResults(data) };
}

function normalizeSearchResults(data) {
  const source = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.items)
      ? data.items
      : [];

  return source.slice(0, 10).map((item) => ({
    title: item.title || item.htmlTitle || "Resultado sem titulo",
    link: item.link || item.url || "",
    displayLink: item.displayLink || safeHostname(item.link || item.url || ""),
    snippet: item.snippet || item.htmlSnippet || "",
    price: item.price || item.priceText || "",
    thumbnailLink: item.thumbnailLink ||
      item.image?.thumbnailLink ||
      item.image?.src ||
      ""
  })).filter((item) => item.link);
}

async function captureEvidence(payload) {
  const url = String(payload?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL invalida para captura.");
  }

  // O Chrome captura com confiabilidade apenas abas visiveis. No MVP a aba e
  // aberta, aguardada por alguns segundos, fotografada e fechada em seguida.
  const tab = await chrome.tabs.create({ url, active: true });

  try {
    await waitForTabLoaded(tab.id, 12000);
    await delay(1800);
    const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await chrome.tabs.remove(tab.id);
    return {
      screenshotData: imageData,
      capturedAt: new Date().toISOString()
    };
  } catch (error) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (_removeError) {
      // Ignore tab cleanup failures.
    }
    throw error;
  }
}

function waitForTabLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch (_error) {
    return "";
  }
}
