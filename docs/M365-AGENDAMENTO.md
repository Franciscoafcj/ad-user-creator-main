# Agendamento de licenças e grupos M365

Na criação individual pela interface, conecte ao M365, selecione a licença e os
grupos e execute a criação no AD. As seleções são enviadas junto com a criação e
salvas pelo servidor após `New-ADUser` retornar com sucesso. A primeira tentativa
ocorre **a partir de 30 minutos após a criação**, não imediatamente.

O prazo é uma espera mínima: se o usuário ou destinatário ainda não estiver
disponível na nuvem, etapas que falharem serão tentadas novamente a cada cinco
minutos. Após 36 tentativas, o agendamento passa para “Requer atenção”. Cada
licença/grupo tem seu resultado salvo; etapas concluídas não são repetidas nas
tentativas seguintes. Uma interrupção entre a alteração remota e a gravação local
pode repetir a última chamada; respostas de membro já existente são aceitas.

## Autenticação e execução

- O servidor continua em `localhost`, com as sessões interativas existentes.
- Mantenha o PowerShell aberto e conectado ao Graph/Exchange necessários.
- O navegador pode ser fechado: não há temporizador dependente da página.
- Ao reiniciar o servidor, reconecte ao M365. Agendamentos vencidos são retomados.
- Sem conexão detectada, a fila aguarda sem consumir tentativas. Sessões expiradas
  podem resultar em falhas das chamadas; reconecte pelo botão existente.
- Não há serviço Windows, tarefa do Agendador do Windows ou autenticação autônoma.
- A verificação ocorre a cada 15 segundos, com um agendamento por verificação.
  Operações usam a mesma sessão PowerShell e podem atrasar respostas HTTP enquanto
  executam. O horário não é uma garantia de execução no segundo exato.
- Antes de executar, a fila verifica o GUID da conta original, o UPN e se está
  habilitada. Alterações incompatíveis exigem revisão pelo operador.

## Acompanhamento

Na aba **Ativar M365**, a seção **Agendamentos M365** mostra o horário local,
estado, etapas concluídas e mensagens da última tentativa. É possível cancelar
pendências ou repetir as etapas pendentes de um agendamento que requer atenção.
Cancelar não desfaz licenças/grupos já aplicados.

Se a conta foi criada com uma versão anterior do servidor, use **Agendar para
conta já criada no AD** na aba Ativar M365: selecione a conta, licença e grupos.
O prazo usa a data original `whenCreated` do AD. Se os 30 minutos já passaram,
a execução será elegível na próxima verificação. Não é necessário recriar a conta.
Agendamentos pendentes duplicados são rejeitados.

### A tela aparece, mas a fila fica vazia

O PowerShell mantém o código do servidor em memória, enquanto HTML/JavaScript
são lidos do disco. Após atualizar os arquivos, a interface pode parecer nova
mesmo com o servidor antigo ainda aberto (as rotas da fila retornam HTTP 404).
Feche o PowerShell que executa o servidor, inicie novamente pelo lançador habitual,
reconecte ao M365 e atualize a página com Ctrl+F5. Apenas atualizar o navegador
não atualiza o backend. A interface verifica a versão anunciada por `/api/ping`
antes de permitir uma criação com agendamento.

A ativação manual continua imediata. A seleção de agendamento está disponível
na criação individual; a tela de lote e os scripts PowerShell exportados não
ganharam seletores de agendamento nesta alteração.

## Persistência e distribuição

Os arquivos ficam em `data/m365-queue/`, fora do Git, sem senhas ou tokens.
Preserve essa pasta nas atualizações e restrinja seu acesso aos operadores da
ferramenta, pois ela contém UPNs e define ações administrativas futuras. Cada
gravação substitui o JSON e mantém a versão anterior em `.bak`.

Se a conta for criada, mas a gravação do agendamento falhar, o resultado informa
os dois estados separadamente. Não recrie a conta: resolva o armazenamento e use
a ativação manual após a sincronização.

Inclua `M365Queue.ps1` e `m365-queue.js` na distribuição, junto aos arquivos já
usados pelo servidor. Reinicie o servidor e recarregue a página após atualizar.

## Verificação offline

Execute `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/M365Queue.Tests.ps1`.
Os testes usam diretório temporário e funções simuladas; não conectam ao AD ou M365.
