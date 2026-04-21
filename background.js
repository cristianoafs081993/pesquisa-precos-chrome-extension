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

    const freight = await captureFreightForTab(tab.id, capturedUrl, payload?.freightZip);
    const imageData = await captureTabWithDebugger(tab.id);
    return {
      screenshotData: imageData,
      capturedAt: new Date().toISOString(),
      requestedUrl: url,
      capturedUrl,
      freight,
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

async function captureFreightForTab(tabId, url, freightZip) {
  const cep = normalizeFreightZip(freightZip);
  if (!isAmazonUrl(url)) {
    return { status: "pending", total: null, cep, text: "Fornecedor sem captura automatica de frete." };
  }

  if (!cep) {
    return { status: "pending", total: null, cep: "", text: "CEP nao configurado." };
  }

  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractAmazonFreight,
      args: [cep]
    });
    return normalizeFreightResult(execution?.result, cep);
  } catch (error) {
    if (isRecoverableFreightNavigationError(error)) {
      try {
        await waitForTabReady(tabId, 15000);
        await delay(2500);
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractAmazonFreight,
          args: [cep]
        });
        return normalizeFreightResult(execution?.result, cep);
      } catch (_retryError) {
        // Fall through to the pending result below.
      }
    }

    return {
      status: "pending",
      total: null,
      cep,
      text: error instanceof Error ? error.message : "Falha ao capturar frete."
    };
  }
}

function normalizeFreightResult(result, cep) {
  if (result?.status === "free") {
    return { status: "free", total: 0, cep, text: result.text || "Frete gratis" };
  }

  if (result?.status === "captured" && Number.isFinite(Number(result.total))) {
    return { status: "captured", total: Number(result.total), cep, text: result.text || "" };
  }

  return {
    status: "pending",
    total: null,
    cep,
    text: result?.text || "Frete nao encontrado automaticamente."
  };
}

async function extractAmazonFreight(cep) {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const zipDigits = String(cep || "").replace(/\D/g, "");
  const formattedZip = zipDigits.length === 8 ? `${zipDigits.slice(0, 5)}-${zipDigits.slice(5)}` : zipDigits;
  const normalizeText = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const textOf = (element) => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  const clickFirst = (selectors) => {
    const element = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
    if (element) {
      element.click();
      return true;
    }
    return false;
  };
  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const parseCurrencyValue = (value) => {
    const match = String(value || "").match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2})/i);
    if (!match) return null;
    const number = Number(match[0].replace(/[^\d,]/g, "").replace(",", "."));
    return Number.isFinite(number) ? number : null;
  };
  const parseFreightCurrency = (value) => {
    const text = String(value || "");
    const freightBeforePrice = text.match(/(?:frete|entrega|envio)[^R$]{0,80}(R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2}))/i);
    if (freightBeforePrice) return parseCurrencyValue(freightBeforePrice[1]);
    const priceBeforeFreight = text.match(/(R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})|R\$\s*\d+(?:,\d{2}))[^R$]{0,80}(?:frete|entrega|envio)/i);
    if (priceBeforeFreight) return parseCurrencyValue(priceBeforeFreight[1]);
    return null;
  };
  const pageZipMatches = () => {
    if (zipDigits.length !== 8) return false;
    const locationText = [
      "#nav-global-location-popover-link",
      "#contextualIngressPtLabel_deliveryShortLine",
      "#glow-ingress-line1",
      "#glow-ingress-line2"
    ].map((selector) => textOf(document.querySelector(selector))).join(" ");
    return locationText.replace(/\D/g, "").includes(zipDigits);
  };
  const fillCepInputs = () => {
    if (zipDigits.length !== 8) return false;
    const firstPart = document.querySelector("#GLUXZipUpdateInput_0");
    const secondPart = document.querySelector("#GLUXZipUpdateInput_1");
    if (firstPart && secondPart) {
      setInputValue(firstPart, zipDigits.slice(0, 5));
      setInputValue(secondPart, zipDigits.slice(5));
      return true;
    }

    const singleInput = document.querySelector("#GLUXZipUpdateInput, input[name='zipCode'], input[autocomplete='postal-code']");
    if (singleInput) {
      setInputValue(singleInput, formattedZip || zipDigits);
      return true;
    }

    return false;
  };
  const applyCepWithGlowApi = async () => {
    if (zipDigits.length !== 8 || !/amazon\.com\.br$/i.test(window.location.hostname)) return false;
    const csrfToken = document.querySelector(".GLUX_Popover meta[name='anti-csrftoken-a2z']")?.content ||
      document.querySelector("meta[name='anti-csrftoken-a2z']")?.content ||
      document.querySelector("#glowValidationToken")?.value ||
      "";
    try {
      const response = await fetch("/portal-migration/hz/glow/address-change?actionSource=glow", {
        method: "POST",
        credentials: "include",
        headers: {
          "accept": "text/html,*/*",
          "anti-csrftoken-a2z": csrfToken,
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest"
        },
        body: JSON.stringify({
          locationType: "LOCATION_INPUT",
          zipCode: formattedZip,
          deviceType: "web",
          storeContext: "home",
          pageType: "Detail",
          actionSource: "glow"
        })
      });
      if (!response.ok) return false;
      const text = await response.text();
      if (!text) return true;
      try {
        const data = JSON.parse(text);
        return data?.isAddressUpdated === 1 || data?.successful === 1 || data?.isValidAddress === 1;
      } catch (_parseError) {
        return true;
      }
    } catch (_error) {
      return false;
    }
  };
  const findFreightText = () => {
    const prioritySelectors = [
      "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
      "#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE",
      "#deliveryBlockMessage",
      "#deliveryBlock_feature_div",
      "#contextualIngressPtLabel_deliveryShortLine",
      "#rightCol",
      "#buybox"
    ];
    const nodes = [
      ...prioritySelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
      ...Array.from(document.querySelectorAll("span, div, p, li"))
    ];
    const seen = new Set();
    const candidates = nodes
      .map(textOf)
      .filter(Boolean)
      .filter((text) => {
        const key = normalizeText(text).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return /(frete|entrega|envio|gratis)/i.test(key) &&
          !/prime video|ofertas exclusivas|aproveite|teste gratis|assinatura|audible/i.test(key);
      })
      .slice(0, 120)
      .map((text) => ({ text, normalized: normalizeText(text).toLowerCase() }));
    for (const candidate of candidates) {
      if (/(?:frete|entrega|envio).{0,40}gratis|gratis.{0,40}(?:frete|entrega|envio)/i.test(candidate.normalized)) {
        return { status: "free", total: 0, text: candidate.text };
      }

      if (/(frete|entrega|envio)/i.test(candidate.normalized)) {
        const total = parseFreightCurrency(candidate.text);
        if (total !== null) {
          return { status: "captured", total, text: candidate.text };
        }
      }
    }

    return { status: "pending", total: null, text: candidates[0]?.text || "" };
  };

  if (pageZipMatches()) {
    const alreadyRendered = findFreightText();
    if (alreadyRendered.status !== "pending") {
      return alreadyRendered;
    }
  }

  clickFirst([
    "#nav-global-location-popover-link",
    "#contextualIngressPtLabel_deliveryShortLine",
    "#glow-ingress-block",
    "[data-action='GLUXAddressBlockAction']"
  ]);
  await sleep(1200);

  if (fillCepInputs()) {
    await sleep(200);
    clickFirst([
      "input[aria-labelledby='GLUXZipUpdate-announce']",
      "#GLUXZipUpdate",
      "span#GLUXZipUpdate input",
      "button[name='glowDoneButton']"
    ]);
    await sleep(2500);
    clickFirst([
      "button[name='glowDoneButton']",
      "#GLUXConfirmClose",
      ".a-popover-footer button",
      "input[data-action-type='SELECT_LOCATION']"
    ]);
    await sleep(1200);
  } else {
    await applyCepWithGlowApi();
    await sleep(2500);
  }

  const captured = findFreightText();
  if (captured.status !== "pending" && pageZipMatches()) {
    return captured;
  }

  return {
    status: "pending",
    total: null,
    text: pageZipMatches()
      ? captured.text || "Frete nao encontrado no bloco de entrega da Amazon."
      : `CEP ${formattedZip || zipDigits} nao foi aplicado pela Amazon antes da leitura do frete.`
  };
}

async function waitForTabReady(tabId, timeoutMs) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "complete") {
      return;
    }
  } catch (_error) {
    return;
  }

  await waitForTabLoaded(tabId, timeoutMs);
}

function isRecoverableFreightNavigationError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /execution context was destroyed|context invalidated|frame was removed|document unloaded|cannot access contents/i.test(message);
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

function isAmazonUrl(value) {
  const host = normalizeHostname(value);
  return host === "amazon.com.br" || host.endsWith(".amazon.com.br");
}

function normalizeFreightZip(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 8 ? digits : "";
}
