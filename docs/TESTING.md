# Politica de testes

Toda nova funcionalidade da extensao deve ser acompanhada por testes automatizados ou por uma justificativa explicita no commit/PR quando o teste nao for viavel.

## Comandos obrigatorios antes de commit

```powershell
npm run check
npm test
```

## Camadas de teste

- Testes unitarios: validam funcoes puras, selecao de fontes, deduplicacao, intercalacao de resultados e regras de normalizacao.
- Testes de integracao: validam o contrato HTTP do `scraper-service` sem depender de sites externos ou abrir navegador real.
- Testes de regressao da extensao: validam que manifesto, content script, background, relatorio e hooks principais continuam presentes.

## Regras de manutencao

- Mudancas em `scraper-service/providers.js` devem atualizar testes de ordem/prioridade das fontes.
- Cada fonte ativada por padrao deve ter extrator especifico, teste de normalizacao e teste contra ruido tecnico: timeout, pagina sem preco, URL fora do dominio e card institucional.
- Mudancas no contrato `/search` devem atualizar testes de integracao HTTP.
- Mudancas em `manifest.json`, `content.js`, `background.js` ou `report.js` devem manter os testes de regressao passando.
- Bugs corrigidos devem virar teste de regressao quando forem reproduziveis em Node sem depender da pagina real do SERPRO.
- Testes nao devem depender de ecommerce externo. A raspagem real pode ser testada manualmente, mas a suite automatizada deve usar mocks.

## Testes manuais complementares

Depois dos testes automatizados, validar no Chrome:

1. Recarregar a extensao em `chrome://extensions`.
2. Recarregar a tela de Itens no Compras.gov.br.
3. Confirmar que o botao `M` aparece na coluna **Acoes**.
4. Abrir **Fontes**, desmarcar uma fonte, adicionar uma fonte personalizada e salvar.
5. Clicar em `M` e confirmar que a busca usa apenas fontes ativas.
6. Confirmar que a tela mostra apenas cards com preco em reais, titulo de produto e dominio esperado.
7. Selecionar uma cotacao, capturar evidencia e gerar relatorio.

Se `npm start` do scraper retornar `EADDRINUSE`, ha uma instancia antiga na porta `8787`. Use `restart-scraper.bat` antes de repetir o teste manual.
