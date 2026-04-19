# Arquitetura do MVP

Este repositorio contem dois componentes acoplados por HTTP local:

- Extensao Chrome Manifest V3: roda dentro do Compras.gov.br/Pesquisa de Precos e adiciona automacoes na interface.
- Servico local de raspagem: roda em `localhost` com Node.js e Playwright para pesquisar fornecedores e devolver resultados normalizados.

## Fluxo geral

1. O operador acessa a pesquisa no Compras.gov.br ja autenticado.
2. O `content.js` e carregado automaticamente nas paginas do SERPRO.
3. Na tela superior de **Itens**, a extensao detecta a tabela `.tabela-itens` e injeta o botao `M` na coluna **Acoes**.
4. Ao clicar em `M`, a extensao extrai numero, descricao, quantidade, unidade, media e mediana da linha.
5. O painel flutuante abre e dispara uma busca para `http://localhost:8787/search`.
6. O `scraper-service` consulta os fornecedores configurados em `providers.js` usando Playwright.
7. A extensao recebe resultados normalizados e exibe cards com titulo, fornecedor, preco, URL e imagem quando disponivel.
8. O operador pode abrir a pagina, capturar evidencia, selecionar a cotacao ou ignorar o resultado.
9. Cotas aceitas e screenshots sao salvos em `chrome.storage.local`.
10. O relatorio local abre `report.html` e usa `window.print()` para salvar como PDF.

## Contrato HTTP

Endpoint padrao:

```text
POST http://localhost:8787/search
```

Payload minimo:

```json
{
  "query": "cadeira empilhavel branca",
  "itemId": "1-cadeira",
  "pesquisaId": "15/2026"
}
```

Resposta normalizada:

```json
{
  "results": [
    {
      "title": "Produto encontrado",
      "link": "https://fornecedor.example/produto",
      "displayLink": "fornecedor.example",
      "snippet": "R$ 100,00 - Fornecedor",
      "thumbnailLink": "https://fornecedor.example/imagem.jpg",
      "price": "R$ 100,00",
      "provider": "mercadolivre",
      "providerName": "Mercado Livre",
      "status": "ok"
    }
  ]
}
```

## Persistencia local

A extensao usa `chrome.storage.local`:

- `marketSessions`: sessoes por pesquisa, usando `market-{pesquisaId}`.
- `marketScreenshots`: screenshots em data URL, indexados por id.

A sessao guarda dados do item, termo de busca editado, ultimos resultados retornados, cotacoes aceitas e status local.

## Pontos de manutencao

- Se o botao `M` nao aparecer, revisar `ensureMarketItemButtons()` e `parseMarketItemRow()` em `content.js`.
- Se a busca nao retornar resultados, validar `scraper-service/providers.js`, pois sites de ecommerce mudam seletores com frequencia.
- Se a captura de evidencia falhar, revisar `captureEvidence()` em `background.js`; o Chrome precisa abrir uma aba visivel para capturar screenshot.
- Se o relatorio nao mostrar screenshots, revisar `report.js` e o tamanho dos dados em `chrome.storage.local`.

## Evolucao para cloud

O `scraper-service` foi escrito para permitir evolucao para container:

- manter o contrato `/search`;
- mover variaveis para ambiente;
- publicar em Cloud Run;
- trocar o endpoint no painel da extensao;
- opcionalmente proteger com `MARKET_SEARCH_TOKEN`.
