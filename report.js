const report = document.querySelector("#report");
const params = new URLSearchParams(location.search);
const sessionId = params.get("sessionId");

loadReport();

async function loadReport() {
  if (!sessionId) {
    report.textContent = "Sessao nao informada.";
    return;
  }

  const { marketSessions = {} } = await chrome.storage.local.get({ marketSessions: {} });
  const session = marketSessions[sessionId];
  if (!session) {
    report.textContent = "Sessao nao encontrada.";
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
      <h1>Pesquisa de Precos - Evidencias de Mercado</h1>
      <section class="meta">
        ${field("Pesquisa", session.pesquisaId || "Nao identificada")}
        ${field("Itens", String(items.length))}
        ${field("Cotacoes aceitas", String(quotes.length))}
        ${field("Gerado em", formatDate(new Date().toISOString()))}
        ${field("Origem", "Extensao Chrome")}
        ${field("Versao", "2.5.0")}
      </section>
      ${items.map(renderItem).join("")}
    </article>
  `;
}

function renderItem(item) {
  const accepted = Object.values(item.cotacoes || {}).filter((quote) => quote.status === "accepted");
  const prices = accepted.map((quote) => parseMoney(quote.precoEditado)).filter((value) => value !== null);
  const min = prices.length ? Math.min(...prices) : null;
  const avg = prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
  const quantity = parseMoney(item.quantidade);
  const total = avg !== null && quantity !== null ? avg * quantity : null;

  return `
    <section>
      <h2>Item ${escapeHtml(item.numero || "")} - ${escapeHtml(item.descricao || "")}</h2>
      <div class="summary">
        ${field("Quantidade", item.quantidade || "-")}
        ${field("Unidade", item.unidade || "-")}
        ${field("Cotacoes aceitas", String(accepted.length))}
        ${field("Menor preco", formatMoney(min))}
        ${field("Media mercado", formatMoney(avg))}
        ${field("Total estimado", formatMoney(total))}
      </div>
      ${accepted.map(renderQuote).join("") || "<p>Nenhuma cotacao aceita para este item.</p>"}
    </section>
  `;
}

function renderQuote(quote, index) {
  return `
    <div class="quote">
      <h3>Cotacao ${index + 1} - ${escapeHtml(quote.fornecedorEditado || quote.dominio || "")}</h3>
      <p><strong>Preco:</strong> ${escapeHtml(quote.precoEditado || "-")}</p>
      <p><strong>Titulo:</strong> ${escapeHtml(quote.titulo || "-")}</p>
      <p class="url"><strong>URL:</strong> ${escapeHtml(quote.url || "-")}</p>
      <p><strong>Capturado em:</strong> ${formatDate(quote.capturadoEm)}</p>
      ${quote.observacao ? `<p><strong>Observacao:</strong> ${escapeHtml(quote.observacao)}</p>` : ""}
      ${quote.screenshotId ? `<img alt="Screenshot da cotacao" data-screenshot-id="${escapeHtml(quote.screenshotId)}">` : "<p>Sem screenshot.</p>"}
    </div>
  `;
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
      image.replaceWith(document.createTextNode("Screenshot nao encontrado."));
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
