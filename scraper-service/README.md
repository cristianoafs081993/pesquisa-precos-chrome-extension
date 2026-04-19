# Servico local de raspagem

Servico Node.js com Playwright para pesquisar fornecedores diretamente, sem Google Custom Search ou Vertex AI Search.

## Como rodar

```powershell
cd "C:\Users\crist\repos\pesquisa-precos-chrome-extension\scraper-service"
npm install
npm run install-browsers
npm start
```

Endpoint local:

```text
http://localhost:8787/search
```

Teste manual:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8787/search" -ContentType "application/json" -Body '{"query":"cadeira empilhavel branca com braco"}'
```

## Contrato

Payload:

```json
{
  "query": "cadeira empilhavel branca com braco",
  "providers": ["mercadolivre", "magalu"]
}
```

Resposta:

```json
{
  "results": [
    {
      "title": "Produto encontrado",
      "link": "https://fornecedor.com/produto",
      "displayLink": "fornecedor.com",
      "snippet": "R$ 100,00 - Fornecedor",
      "thumbnailLink": "https://...",
      "price": "R$ 100,00",
      "provider": "mercadolivre"
    }
  ]
}
```

## Observacoes tecnicas

- O scraping e sensivel a mudancas de HTML dos sites. Os seletores ficam em `providers.js`.
- Alguns sites podem bloquear automacao, captcha ou excesso de requisicoes.
- O MVP roda localmente para validar fluxo. Depois o mesmo servico pode virar container para Cloud Run.
