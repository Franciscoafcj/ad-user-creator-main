# Documentação Técnica Consolidada

Este arquivo contém a Documentação extraída do código-fonte.

## Server.ps1

### Documentação 1

```text
.SYNOPSIS
AD User Creator - Servidor Unificado

.DESCRIPTION
Um único arquivo que centraliza tudo: servidor HTTP + lógica de AD.
Não são necessários scripts externos - tudo roda aqui dentro.

Endpoints disponíveis:
GET  /api/ping              -> health check + token de sessão
GET  /api/ad-data           -> OUs e usuários do AD (ao vivo)
POST /api/criar-usuario     -> cria usuário no AD (JSON)
POST /api/criar-lote        -> cria vários usuários (JSON array)
POST /api/desabilitar       -> desabilita uma conta (JSON)
POST /api/desabilitar-lote  -> desabilita várias contas (JSON)
GET  /api/bloqueados        -> lista usuários com conta bloqueada
POST /api/desbloquear       -> desbloqueia uma conta (JSON)

.NOTES
Execute como Domain Admin para operações no AD.
Requer: Windows PowerShell 5.1+ e módulo ActiveDirectory (RSAT).

.EXAMPLE
.\Server.ps1
.\Server.ps1 -Port 8080
```

## app.js

### Documentação 1

```text
Escapa HTML para prevenir XSS
```

### Documentação 2

```text
Escapa aspas simples para prevenir Injeção no PowerShell
```

### Documentação 3

```text
Normaliza string para uso em login/email (remove acentos, espaços, toLowerCase)
```

### Documentação 4

```text
Extrai o primeiro nome, o útimo sobrenome (para login) e todos os sobrenomes (para o AD).

Exemplo: "Francisco de Assis Floriano Correa Junior"
first    = "Francisco"
last     = "Junior"         ← usado para gerar Login/Email (primeiro.ultimo)
surnames = "de Assis Floriano Correa Junior"  ← usado como -Surname no AD
```

### Documentação 5

```text
Remove tudo que não seja dígito do CPF
```

### Documentação 6

```text
Normaliza CPF:
- Remove pontuação
- Preenche com zeros à esquerda até 11 dígitos
- Retorna string de 11 dígitos ou null se inválido (>11 dígitos)
```

### Documentação 7

```text
Máscara visual do CPF enquanto digita
```

### Documentação 8

```text
Valida CPF (algoritmo oficial)
```

### Documentação 9

```text
Avalia força da senha (0-4)
```

### Documentação 10

```text
Exibe toast de feedback
```

### Documentação 11

```text
Copia texto para área de transferência
```

### Documentação 12

```text
Faz download de arquivo .ps1
```

### Documentação 13

```text
Aplica um colorização básica ao código PowerShell
```

### Documentação 14

```text
Gera o script PowerShell para criar um usuário no AD.
@param {Object} u - Dados do usuário
```

### Documentação 15

```text
Gera script em lote a partir de um array de usuários
```

### Documentação 16

```text
Formata o nome completo: cada palavra começa com maiúscula, exceto as
partículas portuguesas (de, da, do, dos, das, e, di, del, van, von, der, …)
que ficam em minúscula.
A primeira palavra sempre começa com maiúscula independente de ser partícula.
```

### Documentação 17

```text
Verifica se um SAM já existe na lista de usuários do AD
```

### Documentação 18

```text
Gera SAMs alternativos quando o primário está em uso.
Estratégias (nesta ordem):
1. primeiro.OUTRO_SOBRENOME  — outros sobrenomes não-partícula, do penúltimo para o início
2. primeiro.inicial.ultimo   — iniciaação do sobrenome intermediário
3. primeiro.ultimo2, 3, 4    — sufixo numérico como último recurso
```

### Documentação 19

```text
Exibe painel de conflito de SAM com sugestões de alternativas
```

### Documentação 20

```text
Parseia um bloco de texto livre no formato:
Nome: NOME COMPLETO
CPF: 000.000.000-00
(qualquer outro campo é ignorado)
___ ou linha em branco entre registros

Retorna array de { name, cpf } (cpf pode ser '' se ausente no bloco).
```

### Documentação 21

```text
Gera senha individual: "Senh@" + 4 dígitos aleatórios.
Não pode conter parte do nome do usuário para não infringir a política de senhas do AD.
```

### Documentação 22

```text
Resolve um texto de OU (nome, DN parcial ou DN completo) para o DN exato do AD.
```

### Documentação 23

```text
Parseia o CSV e detecta conflitos de SAM (no AD e dentro do próprio lote).
Retorna array de objetos com campo `conflict` e `alternatives`.
```

### Documentação 24

```text
Cria uma linha de usuário dentro da árvore de OUs.
Clicar no usuário:
1. Seleciona a OU onde ele está (pendingNode)
2. Marca o usuário como template pendente (_pendingTemplateUser)
3. Atualiza o painel de detalhes
```

### Documentação 25

```text
Índice (cache) de usuários agrupados por OU (DN lowercase).
Construído uma vez e invalidado quando AD_DATA muda.
```

### Documentação 26

```text
Retorna os usuários dentro de uma OU (por DN exato). Usa cache interno.
```

### Documentação 27

```text
Exibe/oculta o banner de "usuário modelo selecionado" no rodapé do modal
```

### Documentação 28

```text
Constrói a árvore de OUs a partir da lista de DistinguishedNames
retornada pelo Get-ADData.ps1.

Exemplo de DN: "OU=TI,OU=Usuarios,DC=empresa,DC=com,DC=br"
→ caminho: Usuarios > TI
```

### Documentação 29

```text
Mapa global: DN exato (lowercase) → objeto OU do AD.
Populado por buildOUTreeFromAD e usado por resolveOuByName.
```

### Documentação 30

```text
Dado um nome de OU (ex: "TI", "São Paulo") ou um DN parcial/completo,
tenta resolver para o distinguishedName exato registrado no AD.
Retorna o DN exato se encontrado, ou null.
```

### Documentação 31

```text
Escolhe um ícone baseado no nome da OU (heurística simples)
```

### Documentação 32

```text
Ponto de entrada: inicializa a UI com base em window.AD_DATA
```

### Documentação 33

```text
Lista canônica de OUs ordenada: primeiro as mais profundas (mais úteis), depois alfabética
```

### Documentação 34

```text
Retorna caminho pai→filho ex: ["Usuarios", "TI"]
```

### Documentação 35

```text
Filtra a lista por termo
```

### Documentação 36

```text
Destaca texto
```

### Documentação 37

```text
Renderiza dropdown
```

### Documentação 38

```text
Seleciona uma OU
```

### Documentação 39

```text
Limpa seleção
```

### Documentação 40

```text
Renderiza o painel de grupos do usuário modelo
```

### Documentação 41

```text
Gera script PowerShell para desabilitar uma conta no AD.
@param {Object} opts
```

### Documentação 42

```text
Gera script PowerShell para desabilitar múltiplas contas em lote.
@param {Array}  users         - [{sam, displayName}, ...]
@param {string} reason        - motivo global (opcional)
@param {boolean} moveOu       - mover para OU de desabilitados
@param {string} targetOu      - OU de destino (se moveOu=true)
@param {boolean} expirePassword - expirar senha
```

### Documentação 43

```text
Retorna o caminho completo pai→filho como array de strings
```

### Documentação 44

```text
Ícone heurístico baseado no nome
```

### Documentação 45

```text
Lista ordenada: mais profundas primeiro, depois alfabética
```

### Documentação 46

```text
==================================================
AD USER CREATOR — app.js
Lida com:
- Formatação e validação de CPF
- Geração de e-mail e SamAccountName
- Geração de script PowerShell (único e em lote)
- Importação de CSV
- UX: toast, copy, download, password strength
===================================================
```

### Documentação 47

```text
--------- Helpers ----------
```

### Documentação 48

```text
--------- Highlighting ----------
```

### Documentação 49

```text
--------- Script Generator ----------
```

### Documentação 50

```text
--------- CPF interaction ----------
```

### Documentação 51

```text
--------- Name → email / sam ----------
```

### Documentação 52

```text
--------- Password strength ----------
```

### Documentação 53

```text
--------- Toggle password visibility ----------
```

### Documentação 54

```text
--------- Copy buttons (auto) ----------
```

### Documentação 55

```text
--------- Form submit → generate script ----------
```

### Documentação 56

```text
--------- Smart Import (texto livre → CSV) ----------
```

### Documentação 57

```text
--------- CSV Bulk — two-phase flow ----------
```

### Documentação 58

```text
- Renderizar lista de arquivos --
```

### Documentação 59

```text
- Selecionar arquivo --
```

### Documentação 60

```text
- Remover arquivo --
```

### Documentação 61

```text
- Limpar detalhes --
```

### Documentação 62

```text
- Renderizar detalhes de um arquivo --
```

### Documentação 63

```text
- Processar arquivos JSON importados --
```

### Documentação 64

```text
- Event Listeners --
```

## style.css

### Documentação 1

```text
===============================================================
RETRO CYBER-TECH THEME (Warframe 1999 / KIM UI Style)
AD User Creator
================================================================
```

## index.html

### Documentação 1

```text
Efeitos CRT e Grade de Fundo
```

### Documentação 2

```text
JANELA DO DESKTOP (Windows 95 style)
```

### Documentação 3

```text
Barra de Título 3D Clássica
```

### Documentação 4

```text
Ícone AD clean
```

### Documentação 5

```text
Barra de Menus Clássica
```

### Documentação 6

```text
Corpo da Janela Clássica
```

### Documentação 7

```text
Dashboard do AD / Propriedades do Sistema (Substitui os banners antigos por algo retrô)
```

### Documentação 8

```text
SVG Pixel Art de um robozinho administrador de TI retrô
```

### Documentação 9

```text
Ombros
```

### Documentação 10

```text
FORM CARD
```

### Documentação 11

```text
Nome Completo
```

### Documentação 12

```text
Campos ocultos para compatibilidade
```

### Documentação 13

```text
E-mail (auto-gerado)
```

### Documentação 14

```text
Login / SamAccountName
```

### Documentação 15

```text
Aviso de conflito + alternativas
```

### Documentação 16

```text
CPF
```

### Documentação 17

```text
OU (Organizational Unit) — seletor visual
```

### Documentação 18

```text
Usuário Modelo (opcional)
```

### Documentação 19

```text
Painel de grupos do usuário modelo
```

### Documentação 20

```text
Domínio
```

### Documentação 21

```text
Senha
```

### Documentação 22

```text
Alterar senha no próximo login
```

### Documentação 23

```text
Conta habilitada
```

### Documentação 24

```text
Integração M365
```

### Documentação 25

```text
Licença
```

### Documentação 26

```text
Grupos M365
```

### Documentação 27

```text
OUTPUT CARD
```

### Documentação 28

```text
Summary
```

### Documentação 29

```text
Terminal de Execução
```

### Documentação 30

```text
Painel de Informações do Usuário Criado
```

### Documentação 31

```text
BULK SECTION
```

### Documentação 32

```text
Seletor de OU Global para o Lote
```

### Documentação 33

```text
Campo de pesquisa + dropdown
```

### Documentação 34

```text
Chip da OU selecionada
```

### Documentação 35

```text
input hidden mantém o valor DN para o JS do lote
```

### Documentação 36

```text
══ SMART IMPORT PANEL ══
```

### Documentação 37

```text
Usuário Modelo para o Lote
```

### Documentação 38

```text
Painel de grupos do usuário modelo (lote)
```

### Documentação 39

```text
══ PREVIEW TABLE (shown after parse) ══
```

### Documentação 40

```text
Terminal de Execução do Lote
```

### Documentação 41

```text
═══════════════════════════════════════════════════════
PAINEL: Desabilitar Usuário
════════════════════════════════════════════════════════
```

### Documentação 42

```text
Sub-abas Individual / Em Lote
```

### Documentação 43

```text
─────────────── SUB-PAINEL: Individual ───────────────
```

### Documentação 44

```text
CARD: Busca de Usuário
```

### Documentação 45

```text
Campo de busca
```

### Documentação 46

```text
Chip do usuário selecionado
```

### Documentação 47

```text
Motivo (opcional)
```

### Documentação 48

```text
Opções adicionais
```

### Documentação 49

```text
Opção M365 (Oculta se M365 offline)
```

### Documentação 50

```text
CARD: Script / Output
```

### Documentação 51

```text
Summary do usuário selecionado
```

### Documentação 52

```text
Terminal de Execução
```

### Documentação 53

```text
/card-grid individual
```

### Documentação 54

```text
/disSubPanelSingle
```

### Documentação 55

```text
─────────────── SUB-PAINEL: Em Lote ───────────────
```

### Documentação 56

```text
CARD ESQUERDO: Busca + Lista
```

### Documentação 57

```text
Importação Inteligente
```

### Documentação 58

```text
Campo de busca para adicionar ao lote
```

### Documentação 59

```text
Lista de usuários adicionados
```

### Documentação 60

```text
Motivo global (opcional)
```

### Documentação 61

```text
Opções
```

### Documentação 62

```text
Opção M365 Lote (Oculta se M365 offline)
```

### Documentação 63

```text
CARD DIREITO: Script Output
```

### Documentação 64

```text
Summary do lote
```

### Documentação 65

```text
Terminal
```

### Documentação 66

```text
/disSubPanelBulk
```

### Documentação 67

```text
/container
```

### Documentação 68

```text
/panelDisable
```

### Documentação 69

```text
═══════════════════════════════════════════════════════
PAINEL: Usuários Bloqueados
════════════════════════════════════════════════════════
```

### Documentação 70

```text
Header do painel
```

### Documentação 71

```text
Banner offline
```

### Documentação 72

```text
Status bar
```

### Documentação 73

```text
Tabela de bloqueados
```

### Documentação 74

```text
Estado vazio
```

### Documentação 75

```text
Estado inicial (antes da 1ª verificação)
```

### Documentação 76

```text
Tabela
```

### Documentação 77

```text
Terminal de desbloqueio
```

### Documentação 78

```text
/panelLocked
```

### Documentação 79

```text
═══════════════════════════════════════════════════════
PAINEL: Computadores — Leitor de JSON
════════════════════════════════════════════════════════
```

### Documentação 80

```text
Header do painel
```

### Documentação 81

```text
Layout de colunas
```

### Documentação 82

```text
CARD ESQUERDO: Upload + Lista de Arquivos
```

### Documentação 83

```text
Zona de Upload
```

### Documentação 84

```text
Lista de arquivos carregados
```

### Documentação 85

```text
Populado dinamicamente
```

### Documentação 86

```text
CARD DIREITO: Visualização do JSON
```

### Documentação 87

```text
Estado Vazio
```

### Documentação 88

```text
Dados do Hardware (Oculto por padrão)
```

### Documentação 89

```text
Preenchido dinamicamente pelo JS
```

### Documentação 90

```text
/card-grid
```

### Documentação 91

```text
/panelComputers
```

### Documentação 92

```text
═══════════════════════════════════════════════════════
PAINEL: Ativar M365 (Licenças e Grupos)
════════════════════════════════════════════════════════
```

### Documentação 93

```text
CARD ESQUERDO: Atribuição
```

### Documentação 94

```text
Seleção de Usuário do AD
```

### Documentação 95

```text
Chip do usuário selecionado
```

### Documentação 96

```text
UPN / Email de Destino
```

### Documentação 97

```text
Seleção de Licença M365
```

### Documentação 98

```text
Grupos M365
```

### Documentação 99

```text
CARD DIREITO: Terminal / Log de Execução
```

### Documentação 100

```text
/window-body
```

### Documentação 101

```text
/desktop-window
```

### Documentação 102

```text
/desktop-environment
```

### Documentação 103

```text
═══════════════════════════════════════════════════════
MODAL: Seletor Visual de OU (Árvore do AD)
═══════════════════════════════════════════════════════
```

### Documentação 104

```text
Mini pasta amarela pixel-art
```

### Documentação 105

```text
Coluna esquerda: Árvore
```

### Documentação 106

```text
Coluna direita: Detalhes + Grade de Usuários (Estilo RSAT AD DC)
```

### Documentação 107

```text
Barra de pesquisa de usuários dentro da OU
```

### Documentação 108

```text
Tabela de Usuários (RSAT Grid)
```

### Documentação 109

```text
Linhas populadas dinamicamente
```

### Documentação 110

```text
═══════════════════════════════════════════════════════
MODAL: Documentação Técnica ISO 27001 (Windows Help Style)
═══════════════════════════════════════════════════════
```

### Documentação 111

```text
Ícone de Documento pixel-art
```

### Documentação 112

```text
═══════════════════════════════════════════════════════
MODAL: Sobre / Créditos (About Box)
═══════════════════════════════════════════════════════
```

### Documentação 113

```text
═══════════════════════════════════════════════════════
OVERLAY: Tela de Desligamento CRT (Monitor Shut Down)
═══════════════════════════════════════════════════════
```

### Documentação 114

```text
═══════════════════════════════════════════════════════
BARRA DE TAREFAS CLÁSSICA (OS Taskbar)
═══════════════════════════════════════════════════════
```

### Documentação 115

```text
Botão Iniciar
```

### Documentação 116

```text
Ícone Iniciar clean (grid 2x2)
```

### Documentação 117

```text
Menu Iniciar Suspenso
```

### Documentação 118

```text
Ícone Desabilitar clean
```

### Documentação 119

```text
Ícone Bloqueados clean
```

### Documentação 120

```text
Ícone Help pixel-art
```

### Documentação 121

```text
Ícone Info clean
```

### Documentação 122

```text
Ícone Shutdown clean
```

### Documentação 123

```text
Botões das Abas (Active Tasks)
```

### Documentação 124

```text
Ícone Criar Usuário clean
```

### Documentação 125

```text
Ícone Desabilitar Usuário clean
```

### Documentação 126

```text
Ícone Bloqueados clean
```

### Documentação 127

```text
Ícone Cloud/Ativar clean
```

### Documentação 128

```text
Ícone Computadores clean
```

### Documentação 129

```text
System Tray (Canto Direito)
```

### Documentação 130

```text
Servidor: ícone de servidor/monitor clean
```

### Documentação 131

```text
AD: ícone de shield/escudo clean
```

### Documentação 132

```text
Configuração centralizada
```

### Documentação 133

```text
ad-data.js é gerado pelo Get-ADData.ps1 e carrega dados reais do AD
```



## Server.ps1 - ComentÃ¡rios de Linha

`	ext
1. CONFIGURAÇÃO - lê config.json, define defaults

Parâmetro de linha de comando sobrepõe o config

Resolução do diretório de relatórios

-- Logging ------------------------------------------------------

-- Banner --------------------------------------------------------

-- Verificação de privilégios ------------------------------------

2. MÓDULO DO ACTIVE DIRECTORY

2.1 MÓDULOS DE CONECTIVIDADE M365

3. FUNÇÕES AUXILIARES DE AD

Converte PSCustomObject para Hashtable de forma segura

-- Criar usuário no AD -------------------------------------------

-- Validações ----------------------------------------------

-- CPF -----------------------------------------------------

-- OU ------------------------------------------------------

-- Verificar conflitos --------------------------------------

-- Nome completo --------------------------------------------

-- Criar ----------------------------------------------------

-- Copiar departamento e grupos do usuário modelo ----------

-- Desabilitar usuário -------------------------------------------

Remover licenças e grupos M365 (Nuvem / Exchange) se solicitado

Prioriza o EmailAddress (SMTP público/Cloud UPN), pois as licenças e grupos do M365/Exchange utilizam o e-mail como chave.
Se não houver e-mail cadastrado, recorre ao UserPrincipalName local.

1. Remover licenças e grupos no Azure AD via Graph

Remover dos grupos do Azure AD de e-mail (nuvem via Graph, sincronizados via AD local)

Grupo M365 (Unified): remover via Graph API

Lista de Distribuição ou Grupo de Segurança habilitado para e-mail (cloud-only)
NÃO PODEM ser removidos via Graph API (erro Cannot Update a mail-enabled security group).
Devem ser removidos via Exchange Online utilizando o UPN público.

Grupo sincronizado do AD local: remover via Remove-ADGroupMember

Localizar o grupo local pelo e-mail para evitar falha por diferença de nomes

2. Remover de grupos de distribuição no Exchange Online

Fallback quando Graph está desconectado: busca os grupos de e-mail sincronizados no AD local

-- Buscar dados do AD ao vivo ------------------------------------

-- Domínio -------------------------------------------------

-- OUs -----------------------------------------------------

-- Usuários -------------------------------------------------

Cache de dados AD

-- Usuários com conta bloqueada ----------------------------------

3.1 FUNÇÕES AUXILIARES M365 (Exchange Online & Microsoft Graph)

1. Listas de distribuição via Exchange Online

2. Grupos de segurança habilitados para e-mail (Mail-Enabled Security Groups)

Cache de grupos e licenças M365

1. Atribuição de Licenças (Microsoft Graph)

Garante localidade (UsageLocation) para poder receber licenças

2. Adição aos Grupos

-- Desbloquear usuário -------------------------------------------

4. SERVIDOR HTTP - inicialização

Abre o navegador automaticamente (se configurado)

-- Funções de resposta HTTP --------------------------------------

5. ROTEADOR - loop principal de requisições

-- ROTEAMENTO DE ARQUIVOS ESTÁTICOS -------------------------

-- CORS Seguro ----------------------------------------------

Preflight OPTIONS

Bloqueia Origin não autorizada

-- GET /api/ping ---------------------------------------------

-- POST /api/computadores/report (Público, para GPO rodando nos clientes) --

-- Validação de token para rotas protegidas ------------------

-- GET /api/ad-data ------------------------------------------

-- POST /api/ad-data/refresh ----------------------------------

-- GET /api/computadores --------------------------------------

1. Carrega computadores do AD

2. Carrega os últimos relatórios gravados (Latest_*.json)

3. Mescla AD com Relatórios

4. Adiciona computadores que têm relatórios mas não estão no AD

IP seguro

-- POST /api/computadores/upload ------------------------------

-- POST /api/criar-usuario -----------------------------------

-- POST /api/criar-lote --------------------------------------

-- POST /api/desabilitar -------------------------------------

-- POST /api/desabilitar-lote --------------------------------

Aplica opções globais do lote

-- GET /api/bloqueados ---------------------------------------

-- POST /api/desbloquear -------------------------------------

-- POST /api/m365/conectar -----------------------------------

Invalida o cache ao conectar com sucesso

-- GET /api/m365/status --------------------------------------

-- GET /api/m365/grupos --------------------------------------

-- GET /api/m365/licencas ------------------------------------

-- POST /api/m365/aplicar -------------------------------------

Invalida o cache de licenças para atualizar os contadores no frontend

-- 404 -------------------------------------------------------

``n