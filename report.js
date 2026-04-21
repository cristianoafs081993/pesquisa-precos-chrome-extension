const report = document.querySelector("#report");
const params = new URLSearchParams(location.search);
const sessionId = params.get("sessionId");

loadReport();

async function loadReport() {
  if (!sessionId) {
    report.textContent = "Sessão não informada.";
    return;
  }

  const { marketSessions = {} } = await chrome.storage.local.get({ marketSessions: {} });
  const session = marketSessions[sessionId];
  if (!session) {
    report.textContent = "Sessão não encontrada.";
    return;
  }

  report.innerHTML = renderReport(session);
  document.querySelector("[data-print]")?.addEventListener("click", () => window.print());
  await hydrateScreenshots();
}

function renderReport(session) {
  const items = Object.values(session.items || {});
  const quotes = items.flatMap((item) => Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted"));

  return `
    <div class="toolbar">
      <button type="button" data-print>Salvar como PDF</button>
    </div>
    <article class="page">
      <h1>Pesquisa de Preços - Evidências de Mercado</h1>
      <section class="meta">
        ${field("Pesquisa", session.pesquisaId || "Não identificada")}
        ${field("Itens", String(items.length))}
        ${field("Cotações aceitas", String(quotes.length))}
        ${field("Gerado em", formatDate(new Date().toISOString()))}
        ${field("Origem", "Extensão Chrome")}
        ${field("Versão", "2.7.4")}
      </section>
      ${items.map(renderItem).join("")}
    </article>
  `;
}

function renderItem(item) {
  const accepted = Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted");
  const completeQuotes = accepted.filter(hasCompleteFreight);
  const prices = completeQuotes.map((quote) => Number(quote.precoUnitarioComFrete)).filter((value) => Number.isFinite(value));
  const min = prices.length ? Math.min(...prices) : null;
  const avg = prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
  const quantity = parseMoney(item.quantidade);
  const total = avg !== null && quantity !== null ? avg * quantity : null;

  return `
    <section>
      <h2>Item ${escapeHtml(item.numero || "")} - ${escapeHtml(getReportItemDescription(item))}</h2>
      <div class="summary">
        ${field("Quantidade", item.quantidade || "-")}
        ${field("Unidade", item.unidade || "-")}
        ${field("Cotações aceitas", String(accepted.length))}
        ${field("Cotações com frete", String(completeQuotes.length))}
        ${field("Menor preço", formatMoney(min))}
        ${field("Média mercado", formatMoney(avg))}
        ${field("Total estimado", formatMoney(total))}
      </div>
      ${accepted.map(renderQuote).join("") || "<p>Nenhuma cotação aceita para este item.</p>"}
    </section>
  `;
}

function renderQuote(quote, index) {
  return `
    <div class="quote">
      <h3>Cotação ${index + 1} - ${escapeHtml(quote.fornecedorEditado || quote.dominio || "")}</h3>
      <p><strong>Preço:</strong> ${escapeHtml(quote.precoEditado || "-")}</p>
      <p><strong>Frete total:</strong> ${formatFreight(quote)}</p>
      <p><strong>Frete unitário rateado:</strong> ${formatOptionalMoney(quote.freteUnitario)}</p>
      <p><strong>Preço unitário com frete:</strong> ${formatOptionalMoney(quote.precoUnitarioComFrete)}</p>
      <p><strong>Total da cotação:</strong> ${formatQuoteTotal(quote)}</p>
      ${quote.quantidadeAviso ? `<p><strong>Aviso:</strong> ${escapeHtml(quote.quantidadeAviso)}</p>` : ""}
      <p><strong>Titulo:</strong> ${escapeHtml(quote.titulo || "-")}</p>
      <p class="url"><strong>URL:</strong> ${escapeHtml(quote.url || "-")}</p>
      <p><strong>Capturado em:</strong> ${formatDate(quote.capturadoEm)}</p>
      ${quote.observacao ? `<p><strong>Observação:</strong> ${escapeHtml(quote.observacao)}</p>` : ""}
      ${renderScreenshotEvidence(quote)}
    </div>
  `;
}

function hasCompleteFreight(quote) {
  return ["captured", "free", "manual"].includes(quote?.freteStatus) &&
    Number.isFinite(Number(quote.precoUnitarioComFrete));
}

function formatFreight(quote) {
  if (quote?.freteStatus === "free") {
    return "Frete grátis";
  }

  if (quote?.freteStatus === "captured") {
    return `${formatOptionalMoney(quote.freteTotal)} (capturado automaticamente)`;
  }

  if (quote?.freteStatus === "manual") {
    return `${formatOptionalMoney(quote.freteTotal)} (informado manualmente)`;
  }

  return "Pendente";
}

function formatQuoteTotal(quote) {
  const unit = Number(quote?.precoUnitarioComFrete);
  const quantity = Number(quote?.quantidadeConsiderada);
  if (!Number.isFinite(unit) || !Number.isFinite(quantity)) {
    return "-";
  }

  return formatMoney(unit * quantity);
}

function renderScreenshotEvidence(quote) {
  if (!quote.screenshotId) {
    return "<p>Sem screenshot.</p>";
  }

  if (!isScreenshotEvidenceValid(quote)) {
    return "<p>Screenshot não validado para esta cotação.</p>";
  }

  return `<img alt="Screenshot da cotação" data-screenshot-id="${escapeHtml(quote.screenshotId)}">`;
}

function getReportItemDescription(item) {
  return [
    item.descricao,
    item.originalDescription,
    item.canonicalDescription
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || "";
}

function isScreenshotEvidenceValid(quote) {
  const quoteUrl = quote.url || quote.screenshotRequestedUrl || "";
  const screenshotUrl = quote.screenshotUrl || "";
  const quoteHost = normalizeHostname(quoteUrl);
  const screenshotHost = normalizeHostname(screenshotUrl);

  if (!quoteHost || !screenshotHost) {
    return false;
  }

  if (/pesqpreco\.estaleiro\.serpro\.gov\.br$/i.test(screenshotHost)) {
    return false;
  }

  return quoteHost === screenshotHost || quoteHost.endsWith(`.${screenshotHost}`) || screenshotHost.endsWith(`.${quoteHost}`);
}

async function hydrateScreenshots() {
  const images = Array.from(document.querySelectorAll("[data-screenshot-id]"));
  if (!images.length) {
    return;
  }

  const { marketScreenshots = {} } = await chrome.storage.local.get({ marketScreenshots: {} });
  images.forEach((image) => {
    const dataUrl = marketScreenshots[image.dataset.screenshotId];
    if (dataUrl) {
      image.src = dataUrl;
    } else {
      image.replaceWith(document.createTextNode("Screenshot não encontrado."));
    }
  });
}

function field(label, value) {
  return `<div><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

function formatOptionalMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? formatMoney(number) : "-";
}

function parseMoney(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_error) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
