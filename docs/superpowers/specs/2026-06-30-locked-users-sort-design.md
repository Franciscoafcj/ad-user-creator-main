# Design: Ordenação de Usuários Bloqueados por Data

## Objetivo
Adicionar a capacidade de ordenar a tabela de usuários bloqueados pela coluna "Última tentativa inválida" (mais recente / mais antigo).

## Abordagem
A opção escolhida foi a "Opção 2": tornar o cabeçalho da tabela clicável.

### 1. Interface (HTML)
- Alterar o `<th>` da coluna "Última tentativa inválida" na tabela de usuários bloqueados.
- Adicionar o cursor "pointer" para indicar que é clicável.
- Adicionar um ícone/indicador de ordenação ao lado do texto (ex: `⬇` ou `⬆`).

### 2. Lógica (JavaScript - `app.js`)
- Criar estado global para controlar a direção atual da ordenação (`let lockedSortOrder = 'desc'`). O padrão será 'desc' (mais recente primeiro).
- Criar a função auxiliar `parseDateBR(dateStr)`:
  Como os dados vêm da API no formato `dd/MM/yyyy HH:mm:ss`, uma simples comparação de string falharia. A função vai converter `25/12/2026 15:30:00` em um objeto numérico de data do JavaScript para ordenação cronológica precisa.
- Modificar o fluxo de `applyLockedFilter()`:
  1. Pegar todos os usuários bloqueados.
  2. Filtrar pelo botão "Apenas de hoje" (se ativo).
  3. **[NOVO]** Ordenar a lista resultante usando a nova lógica de datas.
  4. Renderizar a tabela.
- Adicionar um *Event Listener* no cabeçalho da coluna para inverter `lockedSortOrder` (entre `desc` e `asc`) e chamar `applyLockedFilter()` novamente.

## Testes e Validação
- Verificar se a tabela inicia com os itens mais recentes no topo.
- Clicar no cabeçalho e verificar se os mais antigos vão para o topo e o ícone inverte.
- Validar se a ordenação lida bem com itens vazios (casos sem a data informada `lastBad`). Eles devem ir para o final da lista.
