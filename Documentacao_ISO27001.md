# Documentação Técnica e de Segurança - AD User Creator
**Classificação da Informação:** Uso Interno
**Objetivo:** Fornecer evidências e detalhamento arquitetural para auditoria de conformidade com a norma ISO/IEC 27001 e políticas internas de Segurança da Informação.

---

## 1. Visão Geral do Sistema
O **AD User Creator** é uma solução de automação para a gestão de identidades e acessos (IAM - Identity and Access Management) no Active Directory. O sistema foi desenvolvido para padronizar e acelerar o processo de *onboarding* (admissão) de colaboradores, reduzindo erros humanos (digitações, permissões incorretas) e garantindo conformidade com a política de controle de acessos da organização.

## 2. Arquitetura da Solução
A aplicação adota uma arquitetura híbrida (Frontend + Backend Local), garantindo que nenhum dado de identidade transite pela internet ou dependa de serviços em nuvem (Air-gapped by design).
* **Frontend (Apresentação):** Desenvolvido em HTML5, CSS3 e Vanilla JavaScript. Roda inteiramente no navegador local em modo offline (`file:///`).
* **Módulo de Extração (`Get-ADData.ps1`):** Script PowerShell de leitura que consulta a topologia do AD (OUs, usuários e grupos) e salva as informações no arquivo local (`ad-data.js`).
* **Servidor de Execução (`Start-Server.ps1`):** Micro-serviço HTTP rodando localmente (Localhost) que atua como ponte segura. Ele recebe as instruções geradas pelo frontend e aciona os módulos oficiais do Active Directory via PowerShell.

## 3. Controle de Acessos (Norma A.9 - Controle de Acesso)
Em estrita conformidade com o princípio do **Privilégio Mínimo (Least Privilege)**, a ferramenta opera sob o conceito de "Zero Elevação":
* A aplicação não possui credenciais *hardcoded*, banco de dados embutido ou conta de serviço (Service Account).
* A execução do servidor local e a consequente gravação de dados no AD utilizam o *Kerberos Ticket* e a sessão autenticada atual do analista logado no Windows.
* Se o analista não possuir delegação explícita no AD para criar contas em uma determinada Unidade Organizacional (OU) ou adicionar usuários a grupos, a operação será sumariamente negada pelo Domain Controller. A matriz de RBAC (*Role-Based Access Control*) do AD é 100% preservada.

## 4. Segurança de Aplicação (Norma A.14 - Aquisição, Desenvolvimento e Manutenção de Sistemas)
O código-fonte incorpora práticas de DevSecOps para mitigar os principais vetores de ataque listados pela OWASP:
* **Prevenção contra Injeção de Comando (Command Injection):** Entradas provenientes de arquivos CSV ou preenchimento manual (ex: nomes, cargos) são sanitizadas rigorosamente pela função `escapePS()`, que envelopa variáveis em aspas simples escapadas, garantindo que o PowerShell processe as entradas como dados estáticos e nunca como comandos.
* **Prevenção contra Cross-Site Scripting (XSS):** Os dados exportados do Active Directory exibidos na interface gráfica passam pela sanitização universal `escapeHTML()`. Isso impede a execução de scripts embutidos no navegador do analista caso a base de origem sofra envenenamento.
* **Proteção de Rede (CORS e Local Bind):** O servidor HTTP local faz *bind* apenas na interface de loopback (`127.0.0.1`), tornando-o invisível para a rede corporativa (LAN). Além disso, a aplicação valida a política de *Cross-Origin Resource Sharing* (CORS) e rejeita imediatamente requisições que não provenham do ambiente local, neutralizando riscos de CSRF (*Cross-Site Request Forgery*) através da internet.

## 5. Trilha de Auditoria e Logs (Norma A.12.4 - Registros e Monitoramento)
A preservação da cadeia de evidências e da rastreabilidade é garantida de forma nativa pela integração direta com a arquitetura da Microsoft:
* A ferramenta atua apenas como orquestradora. Por realizar chamadas aos Cmdlets `New-ADUser` e `Add-ADGroupMember`, o Active Directory audita cada alteração da mesma forma como faria via console (RSAT).
* **Event ID 4720 (Criação de Conta):** Os Controladores de Domínio registram com exatidão que o analista (através do seu SID e usuário do Windows) criou uma conta específica no exato momento da operação.
* **Event IDs 4728/4732/4756 (Grupos de Segurança):** Cada associação ou cópia de modelo de acesso (Template Clone) gera um registro de alteração de privilégios.
Essa modelagem garante que ferramentas de SIEM (Security Information and Event Management) coletem os alertas de forma ininterrupta e confiável.

## 6. Proteção da Informação (Norma A.8 - Gestão de Ativos)
O arquivo estático (`ad-data.js`) abriga um mapeamento das OUs, grupos e perfis de usuário da corporação, classificando-se como dado de Confidencialidade Interna. O fluxo operacional recomenda que o operador utilize a ferramenta de extração (`Get-ADData.ps1`) sob demanda e remova a extração local quando inativo, evitando a exposição de diagramas corporativos em dispositivos de forma persistente.
