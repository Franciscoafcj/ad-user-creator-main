# Implementação: Ordenação de Usuários Bloqueados

## O que foi feito
A funcionalidade de ordenação por data para a lista de usuários bloqueados foi adicionada com sucesso.

### 1. Interface Atualizada
- O cabeçalho "Última tentativa inválida" na tabela de usuários bloqueados agora é interativo.
- Ele apresenta um cursor de "mão" ao passar o mouse e exibe um indicador (⬇️ ou ⬆️) mostrando a direção da ordenação atual.

### 2. Lógica de Ordenação
- A lista de usuários agora é ordenada automaticamente. O comportamento padrão é exibir os bloqueios **mais recentes primeiro** (⬇️).
- Ao clicar no cabeçalho da coluna "Última tentativa inválida", a ordem é invertida para mostrar os **mais antigos primeiro** (⬆️).
- A ordenação leva em consideração a data e a hora exatas extraídas do Active Directory (convertidas corretamente, e não apenas textualmente, para garantir precisão).

## Como testar
1. Acesse o painel web da sua aplicação.
2. Navegue até a aba **Usuários Bloqueados**.
3. Clique no cabeçalho da tabela "Última tentativa inválida".
4. Verifique se a lista inverte a ordem e o ícone de seta (⬇️/⬆️) atualiza corretamente.
