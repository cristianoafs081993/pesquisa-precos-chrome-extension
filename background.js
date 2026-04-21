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
        pesquisaId: payload?.pesquisaId || null,
        providers: Array.isArray(payload?.providers) ? payload.providers : [],
        itemContext: payload?.itemContext || {},
        prefetch: Boolean(payload?.prefetch)
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
  return {
    results: normalizeSearchResults(data),
    meta: data?.meta || {},
    enrichment: data?.meta?.enrichment || null
  };
}

function normalizeSearchResults(data) {
  const source = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.items)
      ? data.items
      : [];

  return source.map((item) => ({
    title: item.title || item.htmlTitle || "Resultado sem titulo",
    link: item.link || item.url || "",
    displayLink: item.displayLink || safeHostname(item.link || item.url || ""),
    snippet: item.snippet || item.htmlSnippet || "",
    price: item.price || item.priceText || "",
    provider: item.provider || "",
    providerName: item.providerName || "",
    thumbnailLink: item.thumbnailLink ||
      item.image?.thumbnailLink ||
      item.image?.src ||
      ""
  })).filter((item) => item.link && item.title && item.price);
}

async function captureEvidence(payload) {
  const url = String(payload?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL invalida para captura.");
  }

  // A captura usa o protocolo de depuracao para evitar roubar o foco da aba
  // atual. A aba de evidencia e aberta em background e permanece disponivel.
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await waitForTabLoaded(tab.id, 12000);
    await delay(1800);
    const finalTab = await chrome.tabs.get(tab.id).catch(() => tab);
    const capturedUrl = finalTab?.url || url;
    if (!isEvidenceUrlAllowed(url, capturedUrl)) {
      throw new Error("A captura nao corresponde a pagina da cotacao.");
    }

    const imageData = await captureTabWithDebugger(tab.id);
    return {
      screenshotData: imageData,
      capturedAt: new Date().toISOString(),
      requestedUrl: url,
      capturedUrl,
      openedTabId: tab.id
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

async function captureTabWithDebugger(tabId) {
  const target = { tabId };

  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    const capture = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });

    if (!capture?.data) {
      throw new Error("Falha ao gerar screenshot da evidencia.");
    }

    return `data:image/png;base64,${capture.data}`;
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_detachError) {
      // Ignore detach failures.
    }
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

function isEvidenceUrlAllowed(requestedUrl, capturedUrl) {
  const requestedHost = normalizeHostname(requestedUrl);
  const capturedHost = normalizeHostname(capturedUrl);
  if (!requestedHost || !capturedHost) {
    return false;
  }

  if (/pesqpreco\.estaleiro\.serpro\.gov\.br$/i.test(capturedHost)) {
    return false;
  }

  return requestedHost === capturedHost || requestedHost.endsWith(`.${capturedHost}`) || capturedHost.endsWith(`.${requestedHost}`);
}

function normalizeHostname(value) {
  return safeHostname(value).replace(/^www\./i, "").toLowerCase();
}
