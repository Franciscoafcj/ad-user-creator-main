(() => {
  const status = document.getElementById('m365QueueStatus');
  const list = document.getElementById('m365QueueList');
  if (!status || !list) return;
  const labels = {
    scheduled: 'Agendado', waiting_auth: 'Aguardando conexão M365',
    running: 'Em execução', retry: 'Aguardando nova tentativa',
    completed: 'Concluído', failed: 'Requer atenção', cancelled: 'Cancelado'
  };
  let loading = false;
  async function refresh() {
    if (loading) return;
    if (!window._serverToken) { status.textContent = 'Conecte ao servidor para consultar a fila.'; return; }
    loading = true;
    try {
      const response = await fetch(`${window._SERVER_BASE || ''}/api/m365/fila`, {
        headers: { 'X-Server-Token': window._serverToken }, cache: 'no-store'
      });
      if (response.status === 404) throw new Error('O servidor aberto ainda não possui a fila. Reinicie o PowerShell pelo Start.bat, reconecte ao M365 e atualize a página.');
      if (!response.ok) throw new Error('Não foi possível consultar a fila.');
      const { jobs } = await response.json();
      list.replaceChildren();
      status.textContent = jobs.length ? `${jobs.length} agendamento(s).` : 'Nenhum agendamento.';
      for (const job of jobs) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 0;border-bottom:1px solid #888';
        const title = document.createElement('strong');
        title.textContent = `${job.userPrincipalName} — ${labels[job.status] || job.status}`;
        row.append(title);
        const info = document.createElement('p');
        const done = job.steps.filter(step => step.done).length;
        info.textContent = `Programado: ${new Date(job.dueAt).toLocaleString('pt-BR')} | Etapas: ${done}/${job.steps.length} | Tentativas: ${job.attempts}`;
        if (['retry', 'waiting_auth'].includes(job.status)) {
          info.textContent += ` | Próxima verificação: ${new Date(job.nextAttemptAt).toLocaleString('pt-BR')}`;
        }
        row.append(info);
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Licenças, grupos e resultado';
        const output = document.createElement('pre');
        output.style.whiteSpace = 'pre-wrap';
        output.textContent = job.steps.map(step => `${step.done ? 'OK' : 'Pendente'}: ${step.name} (${step.source})`).join('\n') + '\n\n' + job.lines.join('\n');
        details.append(summary, output);
        row.append(details);
        const actions = job.status === 'failed' ? ['retry', 'cancel'] :
          ['scheduled', 'waiting_auth', 'retry'].includes(job.status) ? ['cancel'] : [];
        for (const action of actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn-sm';
          button.textContent = action === 'retry' ? 'Repetir etapas pendentes' : 'Cancelar pendências';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const result = await fetch(`${window._SERVER_BASE || ''}/api/m365/fila/acao`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Server-Token': window._serverToken },
                body: JSON.stringify({ id: job.id, action })
              });
              if (!result.ok) throw new Error('A ação não foi salva. Atualize a fila e tente novamente.');
              await refresh();
            } catch (error) { status.textContent = error.message; }
            finally { button.disabled = false; }
          });
          row.append(button);
        }
        list.append(row);
      }
    } catch (error) { status.textContent = error.message; }
    finally { loading = false; }
  }
  window.refreshM365Queue = refresh;
  document.getElementById('refreshM365Queue').addEventListener('click', refresh);
  document.getElementById('tabBtnM365')?.addEventListener('click', refresh);
  refresh();
  setInterval(() => {
    if (document.getElementById('panelM365').style.display !== 'none') refresh();
  }, 15000);
})();
