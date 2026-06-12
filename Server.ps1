<#
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
#>

#Requires -Version 5.1
[CmdletBinding()]
param(
    [int]$Port = 0  # 0 = usa o valor de config.json
)

$ErrorActionPreference = 'Stop'

# ==================================================================
# 1. CONFIGURAÇÃO - lê config.json, define defaults
# ==================================================================
$ConfigFile = Join-Path $PSScriptRoot 'config.json'
$Cfg = @{
    serverPort       = 7510
    dominioEmail     = 'orsegups.com.br'
    ouPadrao         = ''
    logDirectory     = 'logs'
    abrirNavegador   = $true
    reportsDirectory = 'historico'
}

if (Test-Path $ConfigFile) {
    try {
        $json = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($json.serverPort)       { $Cfg.serverPort       = [int]$json.serverPort }
        if ($json.dominioEmail)     { $Cfg.dominioEmail     = [string]$json.dominioEmail }
        if ($json.ouPadrao)         { $Cfg.ouPadrao         = [string]$json.ouPadrao }
        if ($json.logDirectory)     { $Cfg.logDirectory     = [string]$json.logDirectory }
        if ($null -ne $json.abrirNavegador) { $Cfg.abrirNavegador = [bool]$json.abrirNavegador }
        if ($json.reportsDirectory) { $Cfg.reportsDirectory = [string]$json.reportsDirectory }
    } catch {
        Write-Warning "Falha ao ler config.json: $_"
    }
}

# Parâmetro de linha de comando sobrepõe o config
if ($Port -gt 0) { $Cfg.serverPort = $Port }

# Resolução do diretório de relatórios
$ReportsDir = $Cfg.reportsDirectory
if (-not [System.IO.Path]::IsPathRooted($ReportsDir)) {
    $ReportsDir = Join-Path $PSScriptRoot $ReportsDir
}
if (-not (Test-Path $ReportsDir)) {
    try { New-Item -ItemType Directory -Path $ReportsDir -ErrorAction Stop | Out-Null } catch {}
}

# -- Logging ------------------------------------------------------
$LogPath = Join-Path $PSScriptRoot $Cfg.logDirectory
if (-not (Test-Path $LogPath)) { New-Item -ItemType Directory -Path $LogPath | Out-Null }
$LogFile = Join-Path $LogPath "server-$(Get-Date -Format 'yyyy-MM-dd').log"

function Write-Log {
    param([string]$Message, [string]$Color = 'White')
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "  $ts  $Message" -ForegroundColor $Color
    Add-Content -Path $LogFile -Value "[$ts] $Message" -ErrorAction SilentlyContinue
}

# -- Banner --------------------------------------------------------
Clear-Host
Write-Host ''
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host "  [Server]  AD User Creator - Servidor Unificado              " -ForegroundColor Cyan
Write-Host "  [Web]  http://localhost:$($Cfg.serverPort)               " -ForegroundColor Cyan
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host ''

# -- Verificação de privilégios ------------------------------------
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$whoami    = "$env:USERDOMAIN\$env:USERNAME"

$adminTxt = if ($isAdmin) { 'Sim [OK]' } else { 'Não [!]  (operações AD podem falhar sem privilégios)' }
$adminClr = if ($isAdmin) { 'Green' } else { 'Yellow' }

Write-Host "  Usuário  : $whoami"   -ForegroundColor White
Write-Host "  Admin    : $adminTxt" -ForegroundColor $adminClr
Write-Host ''

# ==================================================================
# 2. MÓDULO DO ACTIVE DIRECTORY
# ==================================================================
$ADModuleLoaded = $false
try {
    Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
    $ADModuleLoaded = $true
    Write-Host '  Módulo ActiveDirectory carregado [OK]' -ForegroundColor Green
} catch {
    Write-Host '  [!]  Módulo ActiveDirectory não encontrado.' -ForegroundColor Yellow
    Write-Host '     Instale as RSAT Tools para habilitar operações no AD.' -ForegroundColor DarkGray
}
Write-Host ''

# ==================================================================
# 2.1 MÓDULOS DE CONECTIVIDADE M365
# ==================================================================
$ExchangeModuleLoaded = $false
$GraphModuleLoaded = $false

try {
    if (Get-Module -ListAvailable -Name ExchangeOnlineManagement) {
        $ExchangeModuleLoaded = $true
        Write-Host '  Módulo ExchangeOnlineManagement detectado [OK]' -ForegroundColor Green
    } else {
        Write-Host '  [!] Módulo ExchangeOnlineManagement não instalado no sistema.' -ForegroundColor Yellow
    }
} catch {
    Write-Host '  [!] Falha ao verificar módulo ExchangeOnline: ' $_.Exception.Message -ForegroundColor Yellow
}

try {
    if (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication) {
        $GraphModuleLoaded = $true
        Write-Host '  Módulo Microsoft.Graph detectado [OK]' -ForegroundColor Green
    } else {
        Write-Host '  [!] Módulo Microsoft.Graph não instalado no sistema.' -ForegroundColor Yellow
    }
} catch {
    Write-Host '  [!] Falha ao verificar módulo Microsoft.Graph: ' $_.Exception.Message -ForegroundColor Yellow
}
Write-Host ''

# ==================================================================
# 3. FUNÇÕES AUXILIARES DE AD
# ==================================================================

function Remove-Acentos {
    param([string]$Texto)
    $norm = $Texto.Normalize([System.Text.NormalizationForm]::FormD)
    $sb   = [System.Text.StringBuilder]::new()
    foreach ($c in $norm.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($c)
        }
    }
    return $sb.ToString()
}

function Normalizar-CPF {
    param([string]$CPF)
    $digits = $CPF -replace '\D', ''
    if ($digits.Length -gt 11) { return $null }
    return $digits.PadLeft(11, '0')
}

function Validar-CPF {
    param([string]$CPF11)
    if ($CPF11.Length -ne 11) { return $false }
    if ($CPF11 -match '^(\d)\1{10}$') { return $false }
    $soma = 0
    for ($i = 0; $i -lt 9; $i++) { $soma += [int]::Parse($CPF11[$i]) * (10 - $i) }
    $resto = ($soma * 10) % 11; if ($resto -ge 10) { $resto = 0 }
    if ($resto -ne [int]::Parse($CPF11[9])) { return $false }
    $soma = 0
    for ($i = 0; $i -lt 10; $i++) { $soma += [int]::Parse($CPF11[$i]) * (11 - $i) }
    $resto = ($soma * 10) % 11; if ($resto -ge 10) { $resto = 0 }
    return $resto -eq [int]::Parse($CPF11[10])
}

function ConvertTo-SafeHashtable {
    # Converte PSCustomObject para Hashtable de forma segura
    param([object]$Obj)
    if ($null -eq $Obj) { return @{} }
    if ($Obj -is [hashtable]) { return $Obj }
    $ht = @{}
    try {
        $Obj.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
    } catch {}
    return $ht
}

# -- Criar usuário no AD -------------------------------------------
function Invoke-CriarUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }

        # -- Validações ----------------------------------------------
        if (-not $Data.sam)   { throw 'Campo "sam" é obrigatório.' }
        if (-not $Data.email) { throw 'Campo "email" é obrigatório.' }
        if (-not $Data.senha) { throw 'Campo "senha" é obrigatório.' }
        if (-not $Data.nome)  { throw 'Campo "nome" é obrigatório.' }

        # -- CPF -----------------------------------------------------
        $cpf11 = if ($Data.cpf) { Normalizar-CPF ([string]$Data.cpf) } else { '00000000000' }
        if (-not $cpf11) { throw "CPF inválido: '$($Data.cpf)'" }
        if (-not (Validar-CPF $cpf11)) {
            $linhas.Add("[!]  CPF '$cpf11' não passou na validação dos dígitos verificadores - prosseguindo.")
        }

        # -- OU ------------------------------------------------------
        $ouFinal = if ($Data.ou) { [string]$Data.ou }
                   elseif ($Cfg.ouPadrao) { $Cfg.ouPadrao }
                   else {
                       $dom = (Get-ADDomain).DistinguishedName
                       "OU=Usuarios,$dom"
                   }

        # -- Verificar conflitos --------------------------------------
        if (Get-ADUser -Filter "SamAccountName -eq '$($Data.sam)'" -ErrorAction SilentlyContinue) {
            throw "Login '$($Data.sam)' já existe no AD."
        }
        if (Get-ADUser -Filter "UserPrincipalName -eq '$($Data.email)'" -ErrorAction SilentlyContinue) {
            throw "E-mail/UPN '$($Data.email)' já existe na floresta."
        }

        # -- Nome completo --------------------------------------------
        $nomeCompleto = if ($Data.nomeCompleto) { [string]$Data.nomeCompleto }
                        elseif ($Data.sobrenome) { "$($Data.nome) $($Data.sobrenome)" }
                        else { [string]$Data.nome }

        # -- Criar ----------------------------------------------------
        $senha  = ConvertTo-SecureString ([string]$Data.senha) -AsPlainText -Force
        $params = @{
            Name                  = $nomeCompleto
            GivenName             = [string]$Data.nome
            Surname               = $(if ($Data.sobrenome) { [string]$Data.sobrenome } else { '' })
            SamAccountName        = [string]$Data.sam
            UserPrincipalName     = [string]$Data.email
            EmailAddress          = [string]$Data.email
            Description           = $cpf11
            Path                  = $ouFinal
            AccountPassword       = $senha
            Enabled               = [bool]$(if ($null -ne $Data.habilitado) { $Data.habilitado } else { $true })
            ChangePasswordAtLogon = [bool]$(if ($null -ne $Data.trocarSenha) { $Data.trocarSenha } else { $true })
        }

        if ($Data.departamento) { $params.Department = [string]$Data.departamento }
        if ($Data.cargo)        { $params.Title      = [string]$Data.cargo }

        New-ADUser @params

        $linhas.Add("[OK] Usuário '$nomeCompleto' criado com sucesso!")
        $linhas.Add("   Login  : $($Data.sam)")
        $linhas.Add("   E-mail : $($Data.email)")
        $linhas.Add("   CPF(AD): $cpf11")
        if ($Data.departamento) { $linhas.Add("   Depto  : $($Data.departamento)") }

        # -- Copiar grupos do usuário modelo -------------------------
        if ($Data.usuarioModelo) {
            try {
                $grupos = Get-ADPrincipalGroupMembership -Identity ([string]$Data.usuarioModelo) |
                          Where-Object { $_.Name -ne 'Domain Users' }
                if ($grupos.Count -gt 0) {
                    $linhas.Add("   [Copy] Copiando $($grupos.Count) grupo(s) de '$($Data.usuarioModelo)'...")
                    foreach ($g in $grupos) {
                        try {
                            Add-ADGroupMember -Identity $g.DistinguishedName -Members ([string]$Data.sam) -ErrorAction Stop
                            $linhas.Add("      [OK] $($g.Name)")
                        } catch {
                            $linhas.Add("      [!]  $($g.Name): $($_.Exception.Message)")
                        }
                    }
                }
            } catch {
                $linhas.Add("   [!]  Não foi possível copiar grupos: $($_.Exception.Message)")
            }
        }

        $sucesso = $true

    } catch {
        $linhas.Add("[ERRO] Erro: $($_.Exception.Message)")
    }

    return @{ success = $sucesso; lines = @($linhas) }
}

# -- Desabilitar usuário -------------------------------------------
function Invoke-DesabilitarUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }
        if (-not $Data.sam) { throw 'Campo "sam" é obrigatório.' }

        $user = Get-ADUser -Identity ([string]$Data.sam) -ErrorAction Stop
        Disable-ADAccount -Identity ([string]$Data.sam) -ErrorAction Stop
        $linhas.Add("[OK] Conta '$($Data.sam)' desabilitada com sucesso!")

        if ($Data.expirarSenha -eq $true) {
            Set-ADUser -Identity ([string]$Data.sam) -PasswordNeverExpires $false -ChangePasswordAtLogon $true -ErrorAction SilentlyContinue
            $linhas.Add("   [Key] Senha expirada.")
        }

        if ($Data.moverOu -eq $true -and $Data.ouDestino) {
            Move-ADObject -Identity $user.DistinguishedName -TargetPath ([string]$Data.ouDestino) -ErrorAction Stop
            $linhas.Add("   [Dir] Movido para: $($Data.ouDestino)")
        }

        if ($Data.motivo) {
            $hoje = (Get-Date).ToString('dd/MM/yyyy')
            Set-ADUser -Identity ([string]$Data.sam) -Description "DESABILITADO em $hoje - $($Data.motivo)" -ErrorAction SilentlyContinue
            $linhas.Add("   [Log] Motivo registrado na descrição.")
        }

        # Remover licenças e grupos M365 (Nuvem / Exchange) se solicitado
        if ($Data.removerM365 -eq $true) {
            $upn = $null
            try {
                $aadUser = Get-ADUser -Identity ([string]$Data.sam) -Properties UserPrincipalName, EmailAddress -ErrorAction SilentlyContinue
                if ($aadUser) {
                    $upn = $(if ($aadUser.UserPrincipalName) { $aadUser.UserPrincipalName } else { $aadUser.EmailAddress })
                }
            } catch {}

            if ($upn) {
                # 1. Remover licenças e grupos no Azure AD via Graph
                if ($global:M365ConnectedGraph) {
                    try {
                        $mgUser = Get-MgUser -UserId $upn -Property "Id,AssignedLicenses" -ErrorAction Stop
                        $assigned = @($mgUser.AssignedLicenses)
                        if ($assigned.Count -gt 0) {
                            $skuIds = @($assigned | ForEach-Object { $_.SkuId })
                            $linhas.Add("   [M365 Licenças] Removendo $($skuIds.Count) licença(s)...")
                            Set-MgUserLicense -UserId $upn -AddLicenses @() -RemoveLicenses $skuIds -ErrorAction Stop | Out-Null
                            $linhas.Add("      [OK] Licenças removidas com sucesso!")
                        } else {
                            $linhas.Add("   [M365 Licenças] Usuário não possui licenças ativas na nuvem.")
                        }

                        # Remover dos grupos do Azure AD de e-mail criados na nuvem (ignora grupos do AD local)
                        $mgUserGroups = Get-MgUserMemberOf -UserId $upn -ErrorAction Stop
                        $groupMemberships = @($mgUserGroups | Where-Object { $_.AdditionalProperties['@odata.type'] -eq '#microsoft.graph.group' -or $_.Id })
                        if ($groupMemberships.Count -gt 0) {
                            $removidos = 0
                            $ignorados = 0
                            foreach ($g in $groupMemberships) {
                                $grp = Get-MgGroup -GroupId $g.Id -Property "Id,DisplayName,MailEnabled,Mail,OnPremisesSyncEnabled" -ErrorAction SilentlyContinue
                                if ($grp) {
                                    $isMailEnabled = ($grp.MailEnabled -eq $true -or -not [string]::IsNullOrEmpty($grp.Mail))
                                    $isSynced = ($grp.OnPremisesSyncEnabled -eq $true)
                                    if ($isMailEnabled -and -not $isSynced) {
                                        try {
                                            $linhas.Add("   [M365 Grupos] Removendo do grupo de e-mail da nuvem: $($grp.DisplayName)...")
                                            Remove-MgGroupMemberByRef -GroupId $grp.Id -DirectoryObjectId $mgUser.Id -ErrorAction Stop | Out-Null
                                            $linhas.Add("      [OK] Removido com sucesso!")
                                            $removidos++
                                        } catch {
                                            $linhas.Add("      [!] Falha ao remover do grupo $($grp.DisplayName): $($_.Exception.Message)")
                                        }
                                    } else {
                                        $ignorados++
                                    }
                                }
                            }
                            $linhas.Add("   [M365 Grupos] Concluído: $removidos removido(s), $ignorados ignorado(s) (não e-mail ou do AD local).")
                        } else {
                            $linhas.Add("   [M365 Grupos] Usuário não participa de nenhum grupo no Azure AD.")
                        }
                    } catch {
                        $linhas.Add("   [!] Erro nas operações do Microsoft Graph: $($_.Exception.Message)")
                    }
                } else {
                    $linhas.Add("   [!] Microsoft Graph desconectado. Não foi possível remover licenças/grupos do AAD.")
                }

                # 2. Remover de grupos de distribuição no Exchange Online
                if ($global:M365ConnectedExchange) {
                    try {
                        # Busca rápida apenas das listas de distribuição das quais o usuário é membro
                        $exGroups = @(Get-DistributionGroup -Member $upn -ResultSize Unlimited -ErrorAction SilentlyContinue)
                        if ($exGroups.Count -gt 0) {
                            $removidosEx = 0
                            $ignoradosEx = 0
                            foreach ($eg in $exGroups) {
                                $isSynced = ($eg.IsDirSynced -eq $true)
                                if (-not $isSynced) {
                                    try {
                                        $linhas.Add("   [Exchange Grupos] Removendo da lista de distribuição da nuvem: $($eg.DisplayName)...")
                                        Remove-DistributionGroupMember -Identity $eg.Identity -Member $upn -Confirm:$false -ErrorAction Stop | Out-Null
                                        $linhas.Add("      [OK] Removido com sucesso!")
                                        $removidosEx++
                                    } catch {
                                        $linhas.Add("      [!] Falha ao remover da lista $($eg.DisplayName): $($_.Exception.Message)")
                                    }
                                } else {
                                    $ignoradosEx++
                                }
                            }
                            $linhas.Add("   [Exchange Grupos] Concluído: $removidosEx removido(s), $ignoradosEx ignorado(s) (provêm do AD local).")
                        } else {
                            $linhas.Add("   [Exchange Grupos] Usuário não é membro de nenhuma lista de distribuição.")
                        }
                    } catch {
                        $linhas.Add("   [!] Erro nas operações do Exchange Online: $($_.Exception.Message)")
                    }
                } else {
                    $linhas.Add("   [!] Exchange Online desconectado. Não foi possível remover das listas de distribuição.")
                }
            } else {
                $linhas.Add("   [!] UPN/E-mail não encontrado no AD local para remover licenças/grupos M365.")
            }
        }

        $sucesso = $true

    } catch {
        $linhas.Add("[ERRO] Erro: $($_.Exception.Message)")
    }

    return @{ success = $sucesso; lines = @($linhas) }
}

# -- Buscar dados do AD ao vivo ------------------------------------
function Get-ADInfo {
    $result = @{
        domain      = $null
        currentUser = $null
        ous         = @()
        users       = @()
        generatedAt = (Get-Date).ToString('o')
        error       = $null
    }

    if (-not $ADModuleLoaded) {
        $result.error = 'Módulo ActiveDirectory não disponível. Instale as RSAT Tools.'
        return $result
    }

    try {
        # -- Domínio -------------------------------------------------
        $adDom = Get-ADDomain -ErrorAction Stop
        $result.domain = @{
            dnsRoot           = $adDom.DNSRoot
            netBiosName       = $adDom.NetBIOSName
            distinguishedName = $adDom.DistinguishedName
            domainControllers = @($adDom.PDCEmulator)
        }
        $result.currentUser = @{
            samAccountName = $env:USERNAME
            domainNetBios  = $env:USERDOMAIN
            displayName    = "$env:USERDOMAIN\$env:USERNAME"
        }

        # -- OUs -----------------------------------------------------
        $allOUs = Get-ADOrganizationalUnit -Filter * `
                      -Properties Name, DistinguishedName, Description `
                      -ErrorAction Stop |
                  Sort-Object DistinguishedName |
                  ForEach-Object {
                      @{
                          name              = $_.Name
                          distinguishedName = $_.DistinguishedName
                          description       = $(if ($_.Description) { $_.Description } else { '' })
                      }
                  }
        $result.ous = @($allOUs)

        # -- Usuários -------------------------------------------------
        $allUsers = Get-ADUser -Filter * `
                        -Properties Name, DisplayName, SamAccountName, UserPrincipalName,
                                    EmailAddress, Title, Department, Enabled,
                                    DistinguishedName, MemberOf `
                        -ErrorAction Stop |
                    Sort-Object Name |
                    ForEach-Object {
                        $dn     = $_.DistinguishedName
                        $ou     = if ($dn -match ',(.+)$') { $Matches[1] } else { '' }
                        $grupos = if ($_.MemberOf) {
                            @($_.MemberOf | ForEach-Object {
                                if ($_ -match '^CN=([^,]+)') { $Matches[1] }
                            } | Where-Object { $_ -and $_ -ne 'Domain Users' })
                        } else { @() }

                        @{
                            name              = $_.Name
                            samAccountName    = $_.SamAccountName
                            userPrincipalName = $(if ($_.UserPrincipalName) { $_.UserPrincipalName } else { '' })
                            emailAddress      = $(if ($_.EmailAddress)      { $_.EmailAddress }      else { '' })
                            displayName       = $(if ($_.DisplayName)       { $_.DisplayName }       elseif ($_.Name) { $_.Name } else { $_.SamAccountName })
                            title             = $(if ($_.Title)      { $_.Title }      else { '' })
                            department        = $(if ($_.Department) { $_.Department } else { '' })
                            enabled           = ($_.Enabled -eq $true)
                            distinguishedName = $dn
                            ou                = $ou
                            groups            = $grupos
                        }
                    }
        $result.users = @($allUsers)

    } catch {
        $result.error = $_.Exception.Message
    }

    return $result
}

# -- Usuários com conta bloqueada ----------------------------------
function Get-LockedUsers {
    $result = @{ success = $false; users = @(); error = $null }

    if (-not $ADModuleLoaded) {
        $result.error = 'Módulo ActiveDirectory não disponível.'
        return $result
    }

    try {
        $locked = @(Search-ADAccount -LockedOut -UsersOnly -ErrorAction Stop |
                    Get-ADUser -Properties DisplayName, BadLogonCount, LastBadPasswordAttempt, Department, Title, Enabled -ErrorAction Stop)

        $result.users = @($locked | ForEach-Object {
            @{
                sam        = [string]$_.SamAccountName
                display    = $(if ($_.DisplayName) { [string]$_.DisplayName } else { [string]$_.SamAccountName })
                department = $(if ($_.Department) { [string]$_.Department } else { '' })
                title      = $(if ($_.Title)      { [string]$_.Title }      else { '' })
                badCount   = [int]$(if ($_.BadLogonCount) { $_.BadLogonCount } else { 0 })
                lastBad    = $(if ($_.LastBadPasswordAttempt) { $_.LastBadPasswordAttempt.ToString('dd/MM/yyyy HH:mm:ss') } else { '' })
                enabled    = ($_.Enabled -eq $true)
            }
        })
        $result.success = $true

    } catch {
        $result.error = $_.Exception.Message
    }

    return $result
}

# ==================================================================
# 3.1 FUNÇÕES AUXILIARES M365 (Exchange Online & Microsoft Graph)
# ==================================================================
$global:M365ConnectedExchange = $false
$global:M365ConnectedGraph = $false

function Invoke-ConectarM365 {
    $linhas = [System.Collections.Generic.List[string]]::new()
    $success = $false
    
    try {
        $linhas.Add("[INFO] Iniciando conexão com Microsoft Graph...")
        Connect-MgGraph -Scopes "User.ReadWrite.All", "Organization.Read.All", "Group.ReadWrite.All", "Group.Read.All" -ErrorAction Stop | Out-Null
        $global:M365ConnectedGraph = $true
        $linhas.Add("[OK] Conectado ao Microsoft Graph com sucesso!")
    } catch {
        $global:M365ConnectedGraph = $false
        $linhas.Add("[ERRO] Erro ao conectar no Microsoft Graph: $($_.Exception.Message)")
    }

    try {
        $linhas.Add("[INFO] Iniciando conexão com Exchange Online...")
        Connect-ExchangeOnline -ErrorAction Stop | Out-Null
        $global:M365ConnectedExchange = $true
        $linhas.Add("[OK] Conectado ao Exchange Online com sucesso!")
    } catch {
        $global:M365ConnectedExchange = $false
        $linhas.Add("[ERRO] Erro ao conectar no Exchange Online: $($_.Exception.Message)")
    }

    $success = ($global:M365ConnectedGraph -and $global:M365ConnectedExchange)
    return @{ success = $success; lines = @($linhas) }
}

function Get-M365Status {
    $graphConnected = $false
    try {
        $ctx = Get-MgContext -ErrorAction SilentlyContinue
        if ($ctx) { $graphConnected = $true }
    } catch {}
    $global:M365ConnectedGraph = $graphConnected

    $exchangeConnected = $false
    try {
        $sessions = Get-PSSession | Where-Object { $_.ConfigurationName -eq 'Microsoft.Exchange' }
        if ($sessions.Count -gt 0 -or (Get-Command Get-Mailbox -ErrorAction SilentlyContinue)) {
            $exchangeConnected = $true
        }
    } catch {}
    $global:M365ConnectedExchange = $exchangeConnected

    return @{
        graphConnected = $graphConnected
        exchangeConnected = $exchangeConnected
        modulesInstalled = @{
            exchange = $global:ExchangeModuleLoaded
            graph = $global:GraphModuleLoaded
        }
    }
}

function Get-M365Grupos {
    $grupos = @()
    if ($global:M365ConnectedGraph) {
        try {
            $mgGroups = Get-MgGroup -All -Property "Id,DisplayName,Mail,GroupTypes" -ErrorAction Stop
            foreach ($g in $mgGroups) {
                $type = "Azure AD / Office 365"
                if ($g.GroupTypes -contains "Unified") { $type = "M365 Unified Group" }
                $grupos += @{
                    id = $g.Id
                    name = $g.DisplayName
                    mail = $(if ($g.Mail) { $g.Mail } else { '' })
                    type = $type
                    source = "Graph"
                }
            }
        } catch {
            Write-Log "Erro ao buscar grupos do Graph: $_" 'Yellow'
        }
    }

    if ($global:M365ConnectedExchange) {
        try {
            $exGroups = Get-DistributionGroup -ResultSize Unlimited -ErrorAction Stop
            foreach ($g in $exGroups) {
                $grupos += @{
                    id = $g.PrimarySmtpAddress.ToString()
                    name = $g.DisplayName
                    mail = $g.PrimarySmtpAddress.ToString()
                    type = "Distribution List (Exchange)"
                    source = "Exchange"
                }
            }
        } catch {
            Write-Log "Erro ao buscar grupos do Exchange: $_" 'Yellow'
        }
    }

    return @{ success = $true; groups = $grupos }
}

function Get-M365Licencas {
    $licencas = @()
    if ($global:M365ConnectedGraph) {
        try {
            $skus = Get-MgSubscribedSku -All -ErrorAction Stop
            foreach ($s in $skus) {
                $licencas += @{
                    skuId = $s.SkuId
                    skuPartNumber = $s.SkuPartNumber
                    activeUnits = $s.ActiveUnits
                    consumedUnits = $s.ConsumedUnits
                    availableUnits = ($s.ActiveUnits - $s.ConsumedUnits)
                }
            }
        } catch {
            Write-Log "Erro ao buscar licenças do Graph: $_" 'Yellow'
        }
    }
    return @{ success = $true; licenses = $licencas }
}

function Invoke-AplicarM365 {
    param([hashtable]$Data)
    $linhas = [System.Collections.Generic.List[string]]::new()
    $success = $true

    $upn = $Data.userPrincipalName
    if (-not $upn) {
        return @{ success = $false; lines = @("Erro: UPN do usuário ausente.") }
    }

    $linhas.Add("[INFO] Aplicando configurações de M365 para o usuário: $upn")

    # 1. Atribuição de Licenças (Microsoft Graph)
    if ($Data.licenses -and $Data.licenses.Count -gt 0) {
        if (-not $global:M365ConnectedGraph) {
            $linhas.Add("[ERRO] Não é possível atribuir licenças: Microsoft Graph desconectado.")
            $success = $false
        } else {
            # Garante localidade (UsageLocation) para poder receber licenças
            try {
                $mgUser = Get-MgUser -UserId $upn -Property "Id,UsageLocation" -ErrorAction Stop
                if ($null -eq $mgUser.UsageLocation -or $mgUser.UsageLocation -eq "") {
                    $linhas.Add("   [Localidade] Definindo localidade (UsageLocation) como 'BR'...")
                    Update-MgUser -UserId $upn -UsageLocation "BR" -ErrorAction Stop | Out-Null
                    $linhas.Add("      [OK] Localidade configurada com sucesso!")
                }
            } catch {
                $linhas.Add("   [AVISO] Falha ao verificar/definir a localidade (UsageLocation): $($_.Exception.Message)")
            }

            foreach ($skuId in $Data.licenses) {
                try {
                    $linhas.Add("   [Licença] Atribuindo SKU ID: $skuId ...")
                    Set-MgUserLicense -UserId $upn -AddLicenses @(@{ SkuId = $skuId }) -RemoveLicenses @() -ErrorAction Stop | Out-Null
                    $linhas.Add("      [OK] Licença atribuída com sucesso!")
                } catch {
                    $linhas.Add("      [ERRO] Falha ao atribuir licença: $($_.Exception.Message)")
                    $success = $false
                }
            }
        }
    }

    # 2. Adição aos Grupos
    if ($Data.groups -and $Data.groups.Count -gt 0) {
        $aadUserId = $null
        if ($global:M365ConnectedGraph -and ($Data.groups | Where-Object { $_.source -eq "Graph" })) {
            try {
                $aadUser = Get-MgUser -UserId $upn -ErrorAction Stop
                $aadUserId = $aadUser.Id
            } catch {
                $linhas.Add("[ERRO] Falha ao obter ID do usuário no Azure AD: $($_.Exception.Message)")
                $success = $false
            }
        }

        foreach ($group in $Data.groups) {
            $groupId = $group.id
            $groupSource = $group.source
            $groupName = $group.name

            $linhas.Add("   [Grupo] Adicionando ao grupo '$groupName' ($groupSource)...")

            if ($groupSource -eq "Graph") {
                if (-not $global:M365ConnectedGraph) {
                    $linhas.Add("      [ERRO] Não conectado ao Graph.")
                    $success = $false
                } elseif (-not $aadUserId) {
                    $linhas.Add("      [ERRO] Não foi possível obter o ID do usuário no Azure AD.")
                    $success = $false
                } else {
                    try {
                        New-MgGroupMember -GroupId $groupId -DirectoryObjectId $aadUserId -ErrorAction Stop | Out-Null
                        $linhas.Add("      [OK] Membro adicionado via Graph!")
                    } catch {
                        $msg = $_.Exception.Message
                        if ($msg -like "*already exists*" -or $msg -like "*Request_BadRequest*") {
                            $linhas.Add("      [OK] Usuário já é membro deste grupo.")
                        } else {
                            $linhas.Add("      [ERRO] Falha ao adicionar no Graph: $msg")
                            $success = $false
                        }
                    }
                }
            } elseif ($groupSource -eq "Exchange") {
                if (-not $global:M365ConnectedExchange) {
                    $linhas.Add("      [ERRO] Não conectado ao Exchange Online.")
                    $success = $false
                } else {
                    try {
                        Add-DistributionGroupMember -Identity $groupId -Member $upn -ErrorAction Stop | Out-Null
                        $linhas.Add("      [OK] Membro adicionado via Exchange!")
                    } catch {
                        $msg = $_.Exception.Message
                        if ($msg -like "*already exists*" -or $msg -like "*já existe*") {
                            $linhas.Add("      [OK] Usuário já é membro deste grupo.")
                        } else {
                            $linhas.Add("      [ERRO] Falha ao adicionar via Exchange: $msg")
                            $success = $false
                        }
                    }
                }
            }
        }
    }

    return @{ success = $success; lines = @($linhas) }
}

# -- Desbloquear usuário -------------------------------------------
function Invoke-DesbloquearUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }
        if (-not $Data.sam) { throw 'Campo "sam" é obrigatório.' }

        Unlock-ADAccount -Identity ([string]$Data.sam) -ErrorAction Stop
        $linhas.Add("[OK] Conta '$($Data.sam)' desbloqueada com sucesso!")

        $u = Get-ADUser -Identity ([string]$Data.sam) -Properties LockedOut -ErrorAction SilentlyContinue
        if ($u -and -not $u.LockedOut) { $linhas.Add('   Verificado: conta agora desbloqueada.') }

        $sucesso = $true

    } catch {
        $linhas.Add("[ERRO] Erro: $($_.Exception.Message)")
    }

    return @{ success = $sucesso; lines = @($linhas) }
}

# ==================================================================
# 4. SERVIDOR HTTP - inicialização
# ==================================================================
$Token    = [System.Guid]::NewGuid().ToString('N')
$Listener = [System.Net.HttpListener]::new()
$Listener.Prefixes.Add("http://localhost:$($Cfg.serverPort)/")

try {
    $Listener.Start()
} catch {
    Write-Host "  [ERRO] Não foi possível iniciar na porta $($Cfg.serverPort)" -ForegroundColor Red
    Write-Host "     Erro: $_" -ForegroundColor DarkRed
    Write-Host '     Verifique se outra instância já está em execução.' -ForegroundColor DarkGray
    Read-Host '  Pressione Enter para sair'
    exit 1
}

Write-Host "  [OK] Servidor iniciado em http://localhost:$($Cfg.serverPort)" -ForegroundColor Green
Write-Host ''
Write-Host '  [Pressione Ctrl+C para encerrar]' -ForegroundColor DarkGray
Write-Host ''

# Abre o navegador automaticamente (se configurado)
if ($Cfg.abrirNavegador) {
    try {
        Start-Process "http://localhost:$($Cfg.serverPort)/"
    } catch {
        $indexPath = Join-Path $PSScriptRoot 'index.html'
        if (Test-Path $indexPath) {
            try { Start-Process $indexPath } catch {}
        }
    }
}

# -- Funções de resposta HTTP --------------------------------------
function Send-Json {
    param(
        [System.Net.HttpListenerContext]$Ctx,
        [int]   $Status = 200,
        [object]$Body   = @{}
    )
    $json  = $Body | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

    $r = $Ctx.Response
    $r.StatusCode      = $Status
    $r.ContentType     = 'application/json; charset=utf-8'
    $r.ContentLength64 = $bytes.Length

    $origin = $Ctx.Request.Headers['Origin']
    $ao = if ([string]::IsNullOrEmpty($origin) -or $origin -eq 'null') { 'null' }
          elseif ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') { $origin }
          else { $null }

    if ($ao) { $r.Headers.Add('Access-Control-Allow-Origin', $ao) }
    $r.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $r.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
    $r.Headers.Add('Cache-Control', 'no-store')

    try { $r.OutputStream.Write($bytes, 0, $bytes.Length) } catch {}
    try { $r.OutputStream.Close() } catch {}
}

function Read-JsonBody {
    param([System.Net.HttpListenerContext]$Ctx)
    $reader = [System.IO.StreamReader]::new($Ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
    $raw    = $reader.ReadToEnd()
    $reader.Dispose()
    try { return ConvertTo-SafeHashtable ($raw | ConvertFrom-Json) } catch { return @{} }
}

function Send-StaticFile {
    param(
        [System.Net.HttpListenerContext]$Ctx,
        [string]$FilePath,
        [string]$ContentType
    )
    $r = $Ctx.Response
    if (-not (Test-Path $FilePath)) {
        $r.StatusCode = 404
        try { $r.OutputStream.Close() } catch {}
        return
    }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($FilePath)
        $r.StatusCode      = 200
        $r.ContentType     = $ContentType
        $r.ContentLength64 = $bytes.Length
        
        $origin = $Ctx.Request.Headers['Origin']
        $ao = if ([string]::IsNullOrEmpty($origin) -or $origin -eq 'null') { 'null' }
              elseif ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') { $origin }
              else { $null }
        if ($ao) { $r.Headers.Add('Access-Control-Allow-Origin', $ao) }
        $r.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        $r.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
        $r.Headers.Add('Cache-Control', 'no-store')
        
        $r.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
        $r.StatusCode = 500
    } finally {
        try { $r.OutputStream.Close() } catch {}
    }
}

# ==================================================================
# 5. ROTEADOR - loop principal de requisições
# ==================================================================
try {
    while ($Listener.IsListening) {

        $ctx = $null
        try { $ctx = $Listener.GetContext() } catch { break }

        $req    = $ctx.Request
        $path   = $req.Url.AbsolutePath.ToLower().TrimEnd('/')
        $method = $req.HttpMethod.ToUpper()

        Write-Log "$method $path" 'DarkGray'

        # -- ROTEAMENTO DE ARQUIVOS ESTÁTICOS -------------------------
        if ($method -eq 'GET') {
            if ($path -eq '' -or $path -eq '/' -or $path -eq '/index.html') {
                $filePath = Join-Path $PSScriptRoot 'index.html'
                Send-StaticFile $ctx $filePath 'text/html; charset=utf-8'
                continue
            }
            if ($path -eq '/app.js') {
                $filePath = Join-Path $PSScriptRoot 'app.js'
                Send-StaticFile $ctx $filePath 'application/javascript; charset=utf-8'
                continue
            }
            if ($path -eq '/ad-data.js') {
                $filePath = Join-Path $PSScriptRoot 'ad-data.js'
                Send-StaticFile $ctx $filePath 'application/javascript; charset=utf-8'
                continue
            }
            if ($path -eq '/config.js') {
                $filePath = Join-Path $PSScriptRoot 'config.js'
                Send-StaticFile $ctx $filePath 'application/javascript; charset=utf-8'
                continue
            }
            if ($path -eq '/style.css') {
                $filePath = Join-Path $PSScriptRoot 'style.css'
                Send-StaticFile $ctx $filePath 'text/css; charset=utf-8'
                continue
            }
            if ($path -eq '/favicon.ico') {
                $ctx.Response.StatusCode = 404
                try { $ctx.Response.OutputStream.Close() } catch {}
                continue
            }
        }

        # -- CORS Seguro ----------------------------------------------
        $origin = $req.Headers['Origin']
        $safeOrigin = $null
        if ([string]::IsNullOrEmpty($origin) -or $origin -eq 'null') {
            $safeOrigin = 'null'
        } elseif ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') {
            $safeOrigin = $origin
        }

        # Preflight OPTIONS
        if ($method -eq 'OPTIONS') {
            $ctx.Response.StatusCode = 204
            if ($safeOrigin) { $ctx.Response.Headers.Add('Access-Control-Allow-Origin', $safeOrigin) }
            $ctx.Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            $ctx.Response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
            try { $ctx.Response.OutputStream.Close() } catch {}
            continue
        }

        # Bloqueia Origin não autorizada
        if (-not [string]::IsNullOrEmpty($origin) -and -not $safeOrigin) {
            $ctx.Response.StatusCode = 403
            try { $ctx.Response.OutputStream.Close() } catch {}
            Write-Log '    [!]  Requisição bloqueada por CORS' 'Yellow'
            continue
        }

        # -- GET /api/ping ---------------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/ping') {
            Send-Json $ctx 200 @{
                status  = 'ok'
                token   = $Token
                user    = $whoami
                isAdmin = $isAdmin
                port    = $Cfg.serverPort
                adReady = $ADModuleLoaded
            }
            continue
        }

        # -- POST /api/computadores/report (Público, para GPO rodando nos clientes) --
        if ($method -eq 'POST' -and $path -eq '/api/computadores/report') {
            $body = Read-JsonBody $ctx
            $compName = $null
            if ($body.Computador -and $body.Computador.Nome) {
                $compName = $body.Computador.Nome
            } elseif ($body.computername) {
                $compName = $body.computername
            }
            
            if ($compName) {
                $compNameClean = $compName.ToUpper().Replace("\","").Replace("/","").Replace(":","")
                $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
                
                $jsonFileName = "Diagnostico_$($compNameClean)_$($timestamp).json"
                $jsonPath = Join-Path $ReportsDir $jsonFileName
                
                $latestFileName = "Latest_$($compNameClean).json"
                $latestPath = Join-Path $ReportsDir $latestFileName
                
                $jsonData = $body | ConvertTo-Json -Depth 10 -Compress
                
                try {
                    [System.IO.File]::WriteAllText($jsonPath, $jsonData, [System.Text.Encoding]::UTF8)
                    [System.IO.File]::WriteAllText($latestPath, $jsonData, [System.Text.Encoding]::UTF8)
                    Write-Log "    -> Recebido relatorio HTTP de hardware: $compNameClean" 'Green'
                    Send-Json $ctx 200 @{ success = $true; message = "Relatório HTTP gravado com sucesso." }
                } catch {
                    Write-Log "    -> Erro ao gravar relatorio HTTP de ${compNameClean}: $_" 'Red'
                    Send-Json $ctx 500 @{ error = "Erro ao gravar arquivo de relatorio no servidor." }
                }
            } else {
                Write-Log '    -> Requisicao POST /api/computadores/report invalida (sem nome)' 'Red'
                Send-Json $ctx 400 @{ error = "Dados invalidos." }
            }
            continue
        }

        # -- Validação de token para rotas protegidas ------------------
        $reqToken = $req.Headers['X-Server-Token']
        if ($reqToken -ne $Token) {
            Send-Json $ctx 401 @{ error = 'Token inválido ou ausente.' }
            Write-Log '    [!]  Token inválido - requisição rejeitada' 'Yellow'
            continue
        }

        # -- GET /api/ad-data ------------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/ad-data') {
            Write-Log '    -> Buscando dados do AD ao vivo...' 'Yellow'
            $data  = Get-ADInfo
            $color = if ($data.error) { 'Red' } else { 'Green' }
            Write-Log "    -> $($data.ous.Count) OUs | $($data.users.Count) usuários" $color
            Send-Json $ctx 200 $data
            continue
        }

        # -- GET /api/computadores --------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/computadores') {
            Write-Log '    -> Buscando computadores e relatórios de hardware...' 'Yellow'
            
            # 1. Carrega computadores do AD
            $adComputers = @()
            if ($ADModuleLoaded) {
                try {
                    $adComputers = @(Get-ADComputer -Filter * -Properties Name, DistinguishedName, OperatingSystem, Enabled, IPv4Address -ErrorAction Stop |
                        ForEach-Object {
                            $dn = $_.DistinguishedName
                            $ou = if ($dn -match '^CN=[^,]+,(.+)$') { $Matches[1] } else { '' }
                            @{
                                name      = $_.Name
                                dn        = $dn
                                ou        = $ou
                                os        = $_.OperatingSystem
                                enabled   = ($_.Enabled -eq $true)
                                ip        = $_.IPv4Address
                                hasReport = $false
                            }
                        })
                } catch {
                    Write-Log "    -> Erro ao listar computadores do AD: $_" 'Red'
                }
            }

            # 2. Carrega os últimos relatórios gravados (Latest_*.json)
            $reports = @{}
            if (Test-Path $ReportsDir) {
                try {
                    $files = Get-ChildItem -Path $ReportsDir -Filter "Latest_*.json" -ErrorAction SilentlyContinue
                    foreach ($f in $files) {
                        try {
                            $raw = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
                            $repData = $raw | ConvertFrom-Json
                            
                            $cName = $null
                            if ($repData.Computador -and $repData.Computador.Nome) {
                                $cName = $repData.Computador.Nome
                            }
                            
                            if ($cName) {
                                $reports[$cName.ToUpper()] = @{
                                    file     = $f.Name
                                    date     = $repData.AnaliseData
                                    data     = $repData
                                }
                            }
                        } catch {
                            Write-Log "    -> Erro ao processar arquivo $($f.Name): $_" 'Red'
                        }
                    }
                } catch {
                    Write-Log "    -> Erro ao ler pasta de relatorios: $_" 'Red'
                }
            }

            # 3. Mescla AD com Relatórios
            $mergedList = [System.Collections.Generic.List[object]]::new()
            $matchedNames = @{}

            foreach ($comp in $adComputers) {
                $upperName = $comp.name.ToUpper()
                if ($reports.ContainsKey($upperName)) {
                    $comp.hasReport = $true
                    $comp.reportDate = $reports[$upperName].date
                    $comp.reportData = $reports[$upperName].data
                    $matchedNames[$upperName] = $true
                }
                [void]$mergedList.Add($comp)
            }

            # 4. Adiciona computadores que têm relatórios mas não estão no AD
            foreach ($k in $reports.Keys) {
                if (-not $matchedNames.ContainsKey($k)) {
                    $rep = $reports[$k]
                    $cName = $rep.data.Computador.Nome
                    
                    # IP seguro
                    $ip = "Desconhecido"
                    if ($rep.data.Rede) {
                        if ($rep.data.Rede -is [array]) {
                            if ($rep.data.Rede.Count -gt 0) { $ip = $rep.data.Rede[0].IP }
                        } else {
                            $ip = $rep.data.Rede.IP
                        }
                    }

                    [void]$mergedList.Add(@{
                        name       = $cName
                        dn         = "Local (Sem AD)"
                        ou         = "Local"
                        os         = $rep.data.SO.Nome
                        enabled    = $true
                        ip         = $ip
                        hasReport  = $true
                        reportDate = $rep.date
                        reportData = $rep.data
                    })
                }
            }

            Write-Log "    -> Retornando $($mergedList.Count) computadores." 'Green'
            Send-Json $ctx 200 @{
                success = $true
                computers = @($mergedList)
            }
            continue
        }

        # -- POST /api/computadores/upload ------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/computadores/upload') {
            $body = Read-JsonBody $ctx
            $compName = $null
            if ($body.Computador -and $body.Computador.Nome) {
                $compName = $body.Computador.Nome
            } elseif ($body.computername) {
                $compName = $body.computername
            }

            if ($compName) {
                $compNameClean = $compName.ToUpper().Replace("\","").Replace("/","").Replace(":","")
                $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
                
                $jsonFileName = "Diagnostico_$($compNameClean)_$($timestamp).json"
                $jsonPath = Join-Path $ReportsDir $jsonFileName
                
                $latestFileName = "Latest_$($compNameClean).json"
                $latestPath = Join-Path $ReportsDir $latestFileName
                
                $jsonData = $body | ConvertTo-Json -Depth 10 -Compress
                
                try {
                    [System.IO.File]::WriteAllText($jsonPath, $jsonData, [System.Text.Encoding]::UTF8)
                    [System.IO.File]::WriteAllText($latestPath, $jsonData, [System.Text.Encoding]::UTF8)
                    Write-Log "    -> Relatorio manual importado para: $compNameClean" 'Green'
                    Send-Json $ctx 200 @{ success = $true; message = "Relatório importado e salvo." }
                } catch {
                    Write-Log "    -> Erro ao salvar importacao de ${compNameClean}: $_" 'Red'
                    Send-Json $ctx 500 @{ error = "Erro ao salvar o arquivo importado." }
                }
            } else {
                Write-Log '    -> Requisicao POST /api/computadores/upload invalida (sem nome)' 'Red'
                Send-Json $ctx 400 @{ error = "Arquivo JSON de relatorio invalido ou mal-formatado." }
            }
            continue
        }

        # -- POST /api/criar-usuario -----------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/criar-usuario') {
            $body = Read-JsonBody $ctx
            Write-Log "    -> Criando usuário: $($body.sam)" 'Yellow'
            $result = Invoke-CriarUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    -> $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        # -- POST /api/criar-lote --------------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/criar-lote') {
            $body     = Read-JsonBody $ctx
            $usuarios = @($body.usuarios)
            Write-Log "    -> Criando $($usuarios.Count) usuário(s) em lote..." 'Yellow'

            $allLines = [System.Collections.Generic.List[string]]::new()
            $sucesso  = 0
            $falha    = 0

            foreach ($u in $usuarios) {
                $ut     = ConvertTo-SafeHashtable $u
                $r      = Invoke-CriarUsuario $ut
                $allLines.AddRange([string[]]$r.lines)
                $allLines.Add('')
                if ($r.success) { $sucesso++ } else { $falha++ }
            }

            $allLines.Add("== Resultado: $sucesso criado(s) | $falha erro(s) ==")
            Write-Log "    -> Lote: $sucesso ok | $falha erro(s)" (if ($falha -gt 0) { 'Yellow' } else { 'Green' })

            Send-Json $ctx 200 @{
                success = ($falha -eq 0)
                sucesso = $sucesso
                falha   = $falha
                lines   = @($allLines)
            }
            continue
        }

        # -- POST /api/desabilitar -------------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/desabilitar') {
            $body   = Read-JsonBody $ctx
            Write-Log "    -> Desabilitando: $($body.sam)" 'Yellow'
            $result = Invoke-DesabilitarUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    -> $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        # -- POST /api/desabilitar-lote --------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/desabilitar-lote') {
            $body     = Read-JsonBody $ctx
            $usuarios = @($body.usuarios)
            $opcoes   = @{
                motivo       = $body.motivo
                moverOu      = $body.moverOu
                ouDestino    = $body.ouDestino
                expirarSenha = $body.expirarSenha
                removerM365  = $body.removerM365
            }
            Write-Log "    -> Desabilitando $($usuarios.Count) conta(s) em lote..." 'Yellow'

            $allLines = [System.Collections.Generic.List[string]]::new()
            $sucesso  = 0
            $falha    = 0

            foreach ($u in $usuarios) {
                $ut = ConvertTo-SafeHashtable $u
                # Aplica opções globais do lote
                $ut.motivo       = $opcoes.motivo
                $ut.moverOu      = $opcoes.moverOu
                $ut.ouDestino    = $opcoes.ouDestino
                $ut.expirarSenha = $opcoes.expirarSenha
                $ut.removerM365  = $opcoes.removerM365
                $r = Invoke-DesabilitarUsuario $ut
                $allLines.AddRange([string[]]$r.lines)
                $allLines.Add('')
                if ($r.success) { $sucesso++ } else { $falha++ }
            }

            $allLines.Add("== Resultado: $sucesso desabilitado(s) | $falha erro(s) ==")
            $corLote = if ($falha -gt 0) { 'Yellow' } else { 'Green' }
            Write-Log "    -> Lote: $sucesso ok | $falha erro(s)" $corLote

            Send-Json $ctx 200 @{
                success = ($falha -eq 0)
                sucesso = $sucesso
                falha   = $falha
                lines   = @($allLines)
            }
            continue
        }

        # -- GET /api/bloqueados ---------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/bloqueados') {
            Write-Log '    -> Buscando contas bloqueadas...' 'Yellow'
            $result = Get-LockedUsers
            $cor    = if ($result.users.Count -gt 0) { 'Yellow' } else { 'Green' }
            Write-Log "    -> $($result.users.Count) bloqueado(s)" $cor
            Send-Json $ctx 200 $result
            continue
        }

        # -- POST /api/desbloquear -------------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/desbloquear') {
            $body   = Read-JsonBody $ctx
            Write-Log "    -> Desbloqueando: $($body.sam)" 'Yellow'
            $result = Invoke-DesbloquearUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    -> $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        # -- POST /api/m365/conectar -----------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/m365/conectar') {
            Write-Log '    -> Tentando conectar ao M365 (Exchange & Graph)...' 'Yellow'
            $result = Invoke-ConectarM365
            $color  = $(if ($result.success) { 'Green' } else { 'Red' })
            Write-Log "    -> Conectado ao M365: $($result.success)" $color
            Send-Json $ctx 200 $result
            continue
        }

        # -- GET /api/m365/status --------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/m365/status') {
            $result = Get-M365Status
            Send-Json $ctx 200 $result
            continue
        }

        # -- GET /api/m365/grupos --------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/m365/grupos') {
            $result = Get-M365Grupos
            Send-Json $ctx 200 $result
            continue
        }

        # -- GET /api/m365/licencas ------------------------------------
        if ($method -eq 'GET' -and $path -eq '/api/m365/licencas') {
            $result = Get-M365Licencas
            Send-Json $ctx 200 $result
            continue
        }

        # -- POST /api/m365/aplicar -------------------------------------
        if ($method -eq 'POST' -and $path -eq '/api/m365/aplicar') {
            $body = Read-JsonBody $ctx
            Write-Log "    -> Aplicando licenças/grupos M365 para: $($body.userPrincipalName)" 'Yellow'
            $result = Invoke-AplicarM365 $body
            $color  = $(if ($result.success) { 'Green' } else { 'Red' })
            Write-Log "    -> Resultado M365 aplicar: $($result.success)" $color
            Send-Json $ctx 200 $result
            continue
        }

        # -- 404 -------------------------------------------------------
        Send-Json $ctx 404 @{ error = "Rota não encontrada: $method $path" }
    }

} catch {
    Write-Host ''
    Write-Host "  Erro fatal: $_" -ForegroundColor Red
} finally {
    try { $Listener.Stop()  } catch {}
    try { $Listener.Close() } catch {}
    Write-Host ''
    Write-Host '  Servidor encerrado.' -ForegroundColor Yellow
    Write-Host ''
}
