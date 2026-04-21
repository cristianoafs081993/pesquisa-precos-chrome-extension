# Pesquisa de Precos - Extensao Chrome

Extensao Chrome Manifest V3 para apoiar duas etapas da pesquisa de precos:

- Etapa 1: automatizar regras sobre a coluna **Compor** e exclusoes justificadas dentro da tela de cotacoes.
- Etapa 2: pesquisar mercado a partir da tela superior de **Itens**, capturar evidencias e gerar relatorio local.

Para detalhes de arquitetura, contrato HTTP e pontos de manutencao, consulte `docs/ARCHITECTURE.md`. Para a politica de testes, consulte `docs/TESTING.md`.

## Como instalar

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactacao**.
4. Selecione esta pasta do repositorio:
   `C:\Users\crist\repos\pesquisa-precos-chrome-extension`

## Etapa 1 - Compor e exclusoes

1. Acesse a cotacao no Compras.gov.br, ja autenticado.
2. Abra a extensao e clique em **Abrir painel flutuante**.
3. Configure minimo, maximo e criterio.
4. Use **Pre-visualizar**, **Desmarcar Compor**, **Desfazer** ou **Excluir abaixo/acima dos limites**.

## Etapa 2 - Pesquisa de mercado

1. Acesse a tela **Itens** da pesquisa de precos.
2. A extensao adiciona automaticamente um botao **M** na coluna **Acoes** de cada item.
3. Se o botao nao aparecer, recarregue a pagina depois de recarregar a extensao em `chrome://extensions`.
4. Clique em **M** para abrir o item no painel e iniciar a busca automaticamente.
5. Use **Buscar mercado** para refazer a busca manualmente com outro termo.
6. Em cada resultado, use:
   - **Abrir pagina** para conferir manualmente.
   - **Capturar evidencia** para abrir a pagina, tirar screenshot e selecionar para relatorio.
   - **Selecionar** para aceitar o resultado sem screenshot.
   - **Ignorar** para ocultar o resultado.
7. Use **Ver sessao** para acompanhar itens selecionados.
8. Use **Gerar relatorio** para abrir uma pagina imprimivel e salvar como PDF.
9. Use **Exportar JSON** e **Importar JSON** para backup ou futura integracao com app web.
10. Use **Fontes** para desmarcar fontes padrao ou adicionar fornecedores personalizados.

## Servico local de busca e raspagem

A extensao chama um backend configuravel no painel. No MVP, esse backend e um servico local Node.js com Playwright, sem Google Custom Search e sem Vertex AI Search.

Servico incluido:

`scraper-service/`

Como rodar:

```powershell
cd "C:\Users\crist\repos\pesquisa-precos-chrome-extension\scraper-service"
npm install
npm run install-browsers
npm start
```

Se a porta `8787` ja estiver em uso, use `restart-scraper.bat` na raiz do projeto para encerrar o processo antigo e iniciar a versao atual.

Payload esperado:

```json
{
  "query": "cadeira empilhavel branca com braco",
  "itemId": "1-cadeira",
  "pesquisaId": "15/2026"
}
```

Resposta normalizada:

```json
{
  "results": [
    {
      "title": "Produto",
      "link": "https://exemplo.com/produto",
      "displayLink": "exemplo.com",
      "snippet": "Resumo do resultado",
      "thumbnailLink": "https://...",
      "price": "R$ 100,00",
      "provider": "amazon"
    }
  ]
}
```

Endpoint padrao configurado na extensao:

```text
http://localhost:8787/search
```

Fornecedores iniciais ficam em `scraper-service/providers.js`. O Mercado Livre nao e fonte padrao por ser majoritariamente marketplace. No rollout atual, apenas a Amazon fica habilitada por padrao; as demais fontes permanecem disponiveis em **Fontes**, mas desativadas ate receberem extrator especifico e teste de regressao. O scraper descarta resultados sem preco em reais, fora do dominio esperado ou sem titulo/URL de produto, e falhas de fornecedor nao aparecem como cotacao. O caminho natural depois do MVP e empacotar esse servico em container e publicar no Google Cloud Run.

## Testes

Antes de alterar ou publicar a extensao, rode:

```powershell
npm run check
npm test
```

A politica de testes esta documentada em `docs/TESTING.md`.

## Observacoes

- A extensao nao faz login nem acessa certificado digital.
- A extensao so atua quando o operador abre o painel ou aciona um botao.
- Screenshots sao armazenados localmente em `chrome.storage.local`; a extensao usa `unlimitedStorage` para evitar estourar a cota em pesquisas grandes.
- O relatorio inicial e uma pagina HTML imprimivel via **Salvar como PDF**.
- Para capturar screenshots, o Chrome precisa abrir a pagina em uma aba visivel por alguns segundos.
