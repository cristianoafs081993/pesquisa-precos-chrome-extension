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
6. O `scraper-service` consulta, em paralelo, os fornecedores ativos configurados pelo operador.
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
      "provider": "amazon",
      "providerName": "Amazon Brasil",
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

## Fontes de pesquisa

As fontes padrao ficam em `scraper-service/providers.js` e aparecem para o operador no painel **Fontes** da extensao. O Mercado Livre foi removido das fontes padrao porque ha discussao sobre sua validade por ser majoritariamente marketplace.

O rollout de qualidade e incremental. A fonte Amazon fica habilitada por padrao porque tem extrator especifico, validacao de dominio, URL canonica de produto e exigencia de preco em reais. As demais fontes continuam cadastradas na tela **Fontes**, mas ficam desativadas ate receberem extrator especifico e teste de regressao. Isso evita exibir timeout, pagina institucional, card de login ou resultado sem preco como se fosse cotacao valida.

Ordem padrao:

1. Amazon Brasil
2. Magazine Luiza
3. Americanas
4. Casas Bahia
5. KaBuM
6. Dell Brasil
7. Lenovo Brasil
8. MaisOFFICE
9. Kalunga
10. Fast Shop

O operador pode desmarcar fontes padrao e adicionar fontes personalizadas com URL contendo `{query}`.

## Politica de qualidade do scraping

- Falhas de fornecedor nao sao exibidas como card de resultado.
- Resultado sem titulo, URL ou preco em `R$` e descartado.
- Resultado fora do dominio esperado da fonte e descartado.
- Na Amazon, URLs sao normalizadas para `/dp/{ASIN}` para reduzir duplicidade e limpar parametros de rastreamento.
- Fontes genericas/personalizadas podem ser usadas pelo operador, mas a qualidade final depende dos seletores informados e deve ser validada antes de uso operacional.

## Evolucao para cloud

O `scraper-service` foi escrito para permitir evolucao para container:

- manter o contrato `/search`;
- mover variaveis para ambiente;
- publicar em Cloud Run;
- trocar o endpoint no painel da extensao;
- opcionalmente proteger com `MARKET_SEARCH_TOKEN`.
