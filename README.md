# Pesquisa de Precos - Compor

Extensao Chrome Manifest V3 para desmarcar automaticamente a coluna **Compor** em uma pesquisa de precos do SERPRO, usando uma regra configuravel sobre a coluna **Preco unitario**.

## Como instalar

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactacao**.
4. Selecione esta pasta:
   `C:\Users\crist\OneDrive\Desktop\Obsidian\01 - Projetos\Apps\Pesquisa de preços`

## Como usar

1. Acesse a pesquisa no Chrome, ja autenticado com o certificado digital.
2. Abra a extensao **Pesquisa de Precos - Compor**.
3. Configure os limites e o modo da regra.
4. Clique em **Pre-visualizar** para destacar as linhas que seriam alteradas.
5. Clique em **Aplicar** para desmarcar os switches **Compor** que estiverem marcados.

## Modos de regra

- **Desmarcar dentro da faixa**: com minimo `50` e maximo `100`, desmarca precos maiores que 50 e menores que 100.
- **Desmarcar fora da faixa permitida**: com minimo `50` e maximo `100`, desmarca precos menores que 50 ou maiores que 100.
- **Desmarcar acima do minimo**: usa somente o campo minimo.
- **Desmarcar abaixo do maximo**: usa somente o campo maximo.

Marque **Incluir valores iguais aos limites** se `50` e `100` tambem devem entrar na regra.

## Observacoes

- A extensao nao faz login nem acessa o certificado digital. Ela roda dentro da aba que voce ja abriu e autenticou.
- A extensao nao injeta codigo automaticamente ao carregar a pagina. Ela so atua quando voce clica em **Pre-visualizar** ou **Aplicar**.
- A extensao procura as colunas pelos textos `Preco unitario` e `Compor`, por isso deve continuar funcionando mesmo se a ordem das colunas mudar.
- Se a tabela usar paginacao ou carregamento sob demanda, aplique a regra novamente apos mudar de pagina ou rolar para carregar novas linhas.
- Use primeiro a pre-visualizacao antes de aplicar em uma pesquisa real.
- Se o console mostrar erro `401`, recarregue a pagina ou refaca o login antes de aplicar. Esse erro vem da sessao/token da aplicacao do SERPRO, nao da extensao.
- A aplicacao pode registrar erros Angular internos quando a sessao expira ou alguma chamada do backend falha. A extensao agora clica um switch por vez, com intervalo, para evitar disparos rapidos demais.

## Depois de alterar a extensao

1. Abra `chrome://extensions`.
2. Clique no botao de recarregar da extensao.
3. Recarregue a pagina do SERPRO.
