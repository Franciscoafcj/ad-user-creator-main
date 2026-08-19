

#Requires -Version 5.1
[CmdletBinding()]
param(
    [int]$Port = 0  # 0 = usa o valor de config.json
)

$ErrorActionPreference = 'Stop'

$ConfigFile = Join-Path $PSScriptRoot 'config.json'
$Cfg = @{
    serverPort       = 7510
    dominioEmail     = 'empresa.com.br'
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

if ($Port -gt 0) { $Cfg.serverPort = $Port }

$ReportsDir = $Cfg.reportsDirectory
if (-not [System.IO.Path]::IsPathRooted($ReportsDir)) {
    $ReportsDir = Join-Path $PSScriptRoot $ReportsDir
}
if (-not (Test-Path $ReportsDir)) {
    try { New-Item -ItemType Directory -Path $ReportsDir -ErrorAction Stop | Out-Null } catch {}
}

$LogPath = Join-Path $PSScriptRoot $Cfg.logDirectory
if (-not (Test-Path $LogPath)) { New-Item -ItemType Directory -Path $LogPath | Out-Null }
$LogFile = Join-Path $LogPath "server-$(Get-Date -Format 'yyyy-MM-dd').log"

function Write-Log {
    param([string]$Message, [string]$Color = 'White')
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "  $ts  $Message" -ForegroundColor $Color
    Add-Content -Path $LogFile -Value "[$ts] $Message" -ErrorAction SilentlyContinue
}

Clear-Host
Write-Host ''
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host "  [Server]  AD User Creator - Servidor Unificado              " -ForegroundColor Cyan
Write-Host "  [Web]  http://localhost:$($Cfg.serverPort)               " -ForegroundColor Cyan
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host ''

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$whoami    = "$env:USERDOMAIN\$env:USERNAME"

$adminTxt = if ($isAdmin) { 'Sim [OK]' } else { 'Não [!]  (operações AD podem falhar sem privilégios)' }
$adminClr = if ($isAdmin) { 'Green' } else { 'Yellow' }

Write-Host "  Usuário  : $whoami"   -ForegroundColor White
Write-Host "  Admin    : $adminTxt" -ForegroundColor $adminClr
Write-Host ''

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
    param([object]$Obj)
    if ($null -eq $Obj) { return @{} }
    if ($Obj -is [hashtable]) { return $Obj }
    $ht = @{}
    try {
        $Obj.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
    } catch {}
    return $ht
}

function Invoke-CriarUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }

        if (-not $Data.sam)   { throw 'Campo "sam" é obrigatório.' }
        if (-not $Data.email) { throw 'Campo "email" é obrigatório.' }
        if (-not $Data.senha) { throw 'Campo "senha" é obrigatório.' }
        if (-not $Data.nome)  { throw 'Campo "nome" é obrigatório.' }

        $cpf11 = if ($Data.cpf) { Normalizar-CPF ([string]$Data.cpf) } else { '00000000000' }
        if (-not $cpf11) { throw "CPF inválido: '$($Data.cpf)'" }
        if (-not (Validar-CPF $cpf11)) {
            $linhas.Add("[!]  CPF '$cpf11' não passou na validação dos dígitos verificadores - prosseguindo.")
        }

        $ouFinal = if ($Data.ou) { [string]$Data.ou }
                   elseif ($Cfg.ouPadrao) { $Cfg.ouPadrao }
                   else {
                       $dom = (Get-ADDomain).DistinguishedName
                       "OU=Usuarios,$dom"
                   }

        if (Get-ADUser -Filter "SamAccountName -eq '$($Data.sam)'" -ErrorAction SilentlyContinue) {
            throw "Login '$($Data.sam)' já existe no AD."
        }
        if (Get-ADUser -Filter "UserPrincipalName -eq '$($Data.email)'" -ErrorAction SilentlyContinue) {
            throw "E-mail/UPN '$($Data.email)' já existe na floresta."
        }

        $nomeCompleto = if ($Data.nomeCompleto) { [string]$Data.nomeCompleto }
                        elseif ($Data.sobrenome) { "$($Data.nome) $($Data.sobrenome)" }
                        else { [string]$Data.nome }

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

        if ($Data.usuarioModelo) {
            try {
                $usrModelo = Get-ADUser -Identity ([string]$Data.usuarioModelo) -Properties Department
                if (-not $Data.departamento -and $usrModelo.Department) {
                    Set-ADUser -Identity ([string]$Data.sam) -Department $usrModelo.Department
                    $linhas.Add("   [Copy] Departamento copiado: $($usrModelo.Department)")
                }

                $grupos = Get-ADPrincipalGroupMembership -Identity $usrModelo |
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

        if ($Data.removerM365 -eq $true) {
            $upn = $null
            try {
                $aadUser = Get-ADUser -Identity ([string]$Data.sam) -Properties UserPrincipalName, EmailAddress -ErrorAction SilentlyContinue
                if ($aadUser) {
                    $upn = $(if ($aadUser.EmailAddress) { $aadUser.EmailAddress } else { $aadUser.UserPrincipalName })
                }
            } catch {}

            if ($upn) {
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

                        $mgUserGroups = Get-MgUserMemberOf -UserId $upn -ErrorAction Stop
                        $groupMemberships = @($mgUserGroups | Where-Object { $_.AdditionalProperties['@odata.type'] -eq '#microsoft.graph.group' -or $_.Id })
                        if ($groupMemberships.Count -gt 0) {
                            $removidos = 0
                            $ignorados = 0
                            foreach ($g in $groupMemberships) {
                                $grp = Get-MgGroup -GroupId $g.Id -Property "Id,DisplayName,MailEnabled,Mail,OnPremisesSyncEnabled,OnPremisesSamAccountName,GroupTypes" -ErrorAction SilentlyContinue
                                if ($grp) {
                                    $isMailEnabled = ($grp.MailEnabled -eq $true -or -not [string]::IsNullOrEmpty($grp.Mail))
                                    $isSynced = ($grp.OnPremisesSyncEnabled -eq $true)
                                    $isUnified = ($grp.GroupTypes -contains "Unified")
                                    if ($isMailEnabled) {
                                        if (-not $isSynced) {
                                            if ($isUnified) {
                                                try {
                                                    $linhas.Add("   [M365 Grupos] Removendo do grupo M365 (nuvem): $($grp.DisplayName)...")
                                                    Remove-MgGroupMemberByRef -GroupId $grp.Id -DirectoryObjectId $mgUser.Id -ErrorAction Stop | Out-Null
                                                    $linhas.Add("      [OK] Removido com sucesso!")
                                                    $removidos++
                                                } catch {
                                                    $linhas.Add("      [!] Falha ao remover do grupo $($grp.DisplayName): $($_.Exception.Message)")
                                                }
                                            } else {
                                                if ($global:M365ConnectedExchange) {
                                                    try {
                                                        $linhas.Add("   [Exchange Grupos] Removendo da lista de distribuição (nuvem): $($grp.DisplayName)...")
                                                        Remove-DistributionGroupMember -Identity $grp.Id -Member $upn -Confirm:$false -ErrorAction Stop | Out-Null
                                                        $linhas.Add("      [OK] Removido com sucesso!")
                                                        $removidos++
                                                    } catch {
                                                        $linhas.Add("      [!] Falha ao remover da lista $($grp.DisplayName) via Exchange: $($_.Exception.Message)")
                                                    }
                                                } else {
                                                    $linhas.Add("      [!] Exchange Online desconectado. Não foi possível remover da lista: $($grp.DisplayName)")
                                                }
                                            }
                                        } else {
                                            try {
                                                $mail = if ($grp.Mail) { $grp.Mail } else { $g.AdditionalProperties['mail'] }
                                                $adGroup = $null
                                                if ($mail) {
                                                    $adGroup = Get-ADGroup -Filter "mail -eq '$mail'" -ErrorAction SilentlyContinue
                                                }
                                                $adGroupId = if ($adGroup) { $adGroup.DistinguishedName }
                                                             elseif ($grp.OnPremisesSamAccountName) { $grp.OnPremisesSamAccountName }
                                                             elseif ($g.AdditionalProperties['onPremisesSamAccountName']) { $g.AdditionalProperties['onPremisesSamAccountName'] }
                                                             else { $grp.DisplayName }

                                                $linhas.Add("   [M365 Grupos] Removendo do grupo de e-mail sincronizado (AD local): $($grp.DisplayName)...")
                                                Remove-ADGroupMember -Identity $adGroupId -Members ([string]$Data.sam) -Confirm:$false -ErrorAction Stop
                                                $linhas.Add("      [OK] Removido com sucesso (via AD local)!")
                                                $removidos++
                                            } catch {
                                                $linhas.Add("      [!] Falha ao remover do grupo $($grp.DisplayName) via AD: $($_.Exception.Message)")
                                            }
                                        }
                                    } else {
                                        $ignorados++
                                    }
                                }
                            }
                            $linhas.Add("   [M365 Grupos] Concluído: $removidos removido(s), $ignorados ignorado(s) (sem e-mail).")
                        } else {
                            $linhas.Add("   [M365 Grupos] Usuário não participa de nenhum grupo no Azure AD.")
                        }
                    } catch {
                        $linhas.Add("   [!] Erro nas operações do Microsoft Graph: $($_.Exception.Message)")
                    }
                } else {
                    $linhas.Add("   [!] Microsoft Graph desconectado. Não foi possível remover licenças/grupos do AAD.")
                }

                if ($global:M365ConnectedExchange -and -not $global:M365ConnectedGraph) {
                    try {
                        $adUserGroups = Get-ADPrincipalGroupMembership -Identity ([string]$Data.sam) | Where-Object { $_.Name -ne 'Domain Users' }
                        if ($adUserGroups.Count -gt 0) {
                            $removidosEx = 0
                            foreach ($g in $adUserGroups) {
                                $grpAD = Get-ADGroup -Identity $g.DistinguishedName -Properties mail
                                if ($grpAD.mail) {
                                    try {
                                        $linhas.Add("   [Exchange Grupos (Local Fallback)] Removendo do grupo: $($g.Name)...")
                                        Remove-ADGroupMember -Identity $g.DistinguishedName -Members ([string]$Data.sam) -Confirm:$false -ErrorAction Stop
                                        $linhas.Add("      [OK] Removido com sucesso!")
                                        $removidosEx++
                                    } catch {
                                        $linhas.Add("      [!] Falha ao remover do grupo $($g.Name): $($_.Exception.Message)")
                                    }
                                }
                            }
                            $linhas.Add("   [Exchange Grupos] Concluído: $removidosEx removido(s) via AD local.")
                        } else {
                            $linhas.Add("   [Exchange Grupos] Usuário não é membro de nenhuma lista de distribuição local.")
                        }
                    } catch {
                        $linhas.Add("   [!] Erro nas operações do Exchange Online (Local Fallback): $($_.Exception.Message)")
                    }
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

$script:ADCache = @{ Data = $null; Timestamp = [datetime]::MinValue }
$script:ADCacheTTL = 120  # segundos (2 minutos)

function Get-ADInfoCached {
    $now = [datetime]::Now
    if ($script:ADCache.Data -and ($now - $script:ADCache.Timestamp).TotalSeconds -lt $script:ADCacheTTL) {
        Write-Log '    -> Retornando dados do AD via Cache...' 'Cyan'
        return $script:ADCache.Data
    }
    $data = Get-ADInfo  # Query real ao AD
    if (-not $data.error) {
        $script:ADCache.Data = $data
        $script:ADCache.Timestamp = $now
    }
    return $data
}

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
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    if ($global:M365ConnectedExchange) {
        try {
            $exGroups = Get-DistributionGroup -ResultSize Unlimited -ErrorAction Stop
            foreach ($g in $exGroups) {
                $mail = $g.PrimarySmtpAddress.ToString()
                if ($seen.Contains($mail)) { continue }
                $seen.Add($mail) | Out-Null

                $type = "Distribution List (Exchange)"
                if ($g.IsDirSynced -eq $true) { $type = "$type (AD Sync)" }

                $grupos += @{
                    id = $mail
                    name = $g.DisplayName
                    mail = $mail
                    type = $type
                    source = "Exchange"
                }
            }
        } catch {
            Write-Log "Erro ao buscar listas de distribuição do Exchange: $_" 'Yellow'
        }

        try {
            $mesgGroups = Get-DistributionGroup -RecipientTypeDetails MailUniversalSecurityGroup -ResultSize Unlimited -ErrorAction Stop
            foreach ($g in $mesgGroups) {
                $mail = $g.PrimarySmtpAddress.ToString()
                if ($seen.Contains($mail)) { continue }
                $seen.Add($mail) | Out-Null

                $type = "Mail-Enabled Security Group"
                if ($g.IsDirSynced -eq $true) { $type = "$type (AD Sync)" }

                $grupos += @{
                    id = $mail
                    name = $g.DisplayName
                    mail = $mail
                    type = $type
                    source = "Exchange"
                }
            }
        } catch {
            Write-Log "Erro ao buscar grupos de segurança habilitados para e-mail: $_" 'Yellow'
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
                $totalUnits    = [int]($s.PrepaidUnits.Enabled)
                $consumedUnits = [int]($s.ConsumedUnits)
                $availableUnits = $totalUnits - $consumedUnits

                $licencas += @{
                    skuId          = $s.SkuId
                    skuPartNumber  = $s.SkuPartNumber
                    totalUnits     = $totalUnits
                    consumedUnits  = $consumedUnits
                    availableUnits = $availableUnits
                }
            }
        } catch {
            Write-Log "Erro ao buscar licenças do Graph: $_" 'Yellow'
        }
    }
    return @{ success = $true; licenses = $licencas }
}

$script:M365GroupsCache = @{ Data = $null; Timestamp = [datetime]::MinValue }
$script:M365GroupsCacheTTL = 300  # 5 minutos

$script:M365LicensesCache = @{ Data = $null; Timestamp = [datetime]::MinValue }
$script:M365LicensesCacheTTL = 300  # 5 minutos

function Get-M365GruposCached {
    $now = [datetime]::Now
    if ($script:M365GroupsCache.Data -and ($now - $script:M365GroupsCache.Timestamp).TotalSeconds -lt $script:M365GroupsCacheTTL) {
        Write-Log '    -> Retornando grupos M365 via Cache...' 'Cyan'
        return $script:M365GroupsCache.Data
    }
    Write-Log '    -> Buscando grupos M365 ao vivo do Exchange/Graph...' 'Yellow'
    $data = Get-M365Grupos
    if ($data.success -and $data.groups -and $data.groups.Count -gt 0) {
        $script:M365GroupsCache.Data = $data
        $script:M365GroupsCache.Timestamp = $now
    }
    return $data
}

function Get-M365LicencasCached {
    $now = [datetime]::Now
    if ($script:M365LicensesCache.Data -and ($now - $script:M365LicensesCache.Timestamp).TotalSeconds -lt $script:M365LicensesCacheTTL) {
        Write-Log '    -> Retornando licenças M365 via Cache...' 'Cyan'
        return $script:M365LicensesCache.Data
    }
    Write-Log '    -> Buscando licenças M365 ao vivo do Graph...' 'Yellow'
    $data = Get-M365Licencas
    if ($data.success -and $data.licenses -and $data.licenses.Count -gt 0) {
        $script:M365LicensesCache.Data = $data
        $script:M365LicensesCache.Timestamp = $now
    }
    return $data
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

    if ($Data.licenses -and $Data.licenses.Count -gt 0) {
        if (-not $global:M365ConnectedGraph) {
            $linhas.Add("[ERRO] Não é possível atribuir licenças: Microsoft Graph desconectado.")
            $success = $false
        } else {
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

function Compress-GZip {
    param([byte[]]$Bytes)
    $ms = [System.IO.MemoryStream]::new()
    $gz = [System.IO.Compression.GZipStream]::new($ms, [System.IO.Compression.CompressionMode]::Compress)
    $gz.Write($Bytes, 0, $Bytes.Length)
    $gz.Close()
    return $ms.ToArray()
}

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

    $acceptEncoding = $Ctx.Request.Headers['Accept-Encoding']
    if ($acceptEncoding -and $acceptEncoding.Contains('gzip')) {
        $bytes = Compress-GZip $bytes
        $r.Headers.Add('Content-Encoding', 'gzip')
    }

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

        $acceptEncoding = $Ctx.Request.Headers['Accept-Encoding']
        if ($acceptEncoding -and $acceptEncoding.Contains('gzip')) {
            $bytes = Compress-GZip $bytes
            $r.Headers.Add('Content-Encoding', 'gzip')
        }

        $r.ContentLength64 = $bytes.Length
        
        $origin = $Ctx.Request.Headers['Origin']
        $ao = if ([string]::IsNullOrEmpty($origin) -or $origin -eq 'null') { 'null' }
              elseif ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') { $origin }
              else { $null }
        if ($ao) { $r.Headers.Add('Access-Control-Allow-Origin', $ao) }
        $r.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        $r.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
        $r.Headers.Add('Cache-Control', 'public, max-age=300')  # 5 minutos
        
        $r.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
        $r.StatusCode = 500
    } finally {
        try { $r.OutputStream.Close() } catch {}
    }
}

try {
    while ($Listener.IsListening) {

        $ctx = $null
        try { $ctx = $Listener.GetContext() } catch { break }

        $req    = $ctx.Request
        $path   = $req.Url.AbsolutePath.ToLower().TrimEnd('/')
        $method = $req.HttpMethod.ToUpper()

        Write-Log "$method $path" 'DarkGray'

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

        $origin = $req.Headers['Origin']
        $safeOrigin = $null
        if ([string]::IsNullOrEmpty($origin) -or $origin -eq 'null') {
            $safeOrigin = 'null'
        } elseif ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') {
            $safeOrigin = $origin
        }

        if ($method -eq 'OPTIONS') {
            $ctx.Response.StatusCode = 204
            if ($safeOrigin) { $ctx.Response.Headers.Add('Access-Control-Allow-Origin', $safeOrigin) }
            $ctx.Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            $ctx.Response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
            try { $ctx.Response.OutputStream.Close() } catch {}
            continue
        }

        if (-not [string]::IsNullOrEmpty($origin) -and -not $safeOrigin) {
            $ctx.Response.StatusCode = 403
            try { $ctx.Response.OutputStream.Close() } catch {}
            Write-Log '    [!]  Requisição bloqueada por CORS' 'Yellow'
            continue
        }

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

        $reqToken = $req.Headers['X-Server-Token']
        if ($reqToken -ne $Token) {
            Send-Json $ctx 401 @{ error = 'Token inválido ou ausente.' }
            Write-Log '    [!]  Token inválido - requisição rejeitada' 'Yellow'
            continue
        }

        if ($method -eq 'GET' -and $path -eq '/api/ad-data') {
            Write-Log '    -> Buscando dados do AD...' 'Yellow'
            $data  = Get-ADInfoCached
            $color = if ($data.error) { 'Red' } else { 'Green' }
            Write-Log "    -> $($data.ous.Count) OUs | $($data.users.Count) usuários" $color
            Send-Json $ctx 200 $data
            continue
        }

        if ($method -eq 'POST' -and $path -eq '/api/ad-data/refresh') {
            Write-Log '    -> Invalidando cache AD e recarregando...' 'Yellow'
            $script:ADCache.Timestamp = [datetime]::MinValue
            $data = Get-ADInfoCached
            $color = if ($data.error) { 'Red' } else { 'Green' }
            Write-Log "    -> $($data.ous.Count) OUs | $($data.users.Count) usuários (atualizado)" $color
            Send-Json $ctx 200 $data
            continue
        }

        if ($method -eq 'GET' -and $path -eq '/api/computadores') {
            Write-Log '    -> Buscando computadores e relatórios de hardware...' 'Yellow'
            
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

            foreach ($k in $reports.Keys) {
                if (-not $matchedNames.ContainsKey($k)) {
                    $rep = $reports[$k]
                    $cName = $rep.data.Computador.Nome
                    
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

        if ($method -eq 'POST' -and $path -eq '/api/criar-usuario') {
            $body = Read-JsonBody $ctx
            Write-Log "    -> Criando usuário: $($body.sam)" 'Yellow'
            $result = Invoke-CriarUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    -> $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

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

        if ($method -eq 'POST' -and $path -eq '/api/desabilitar') {
            $body   = Read-JsonBody $ctx
            Write-Log "    -> Desabilitando: $($body.sam)" 'Yellow'
            $result = Invoke-DesabilitarUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    -> $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

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

        if ($method -eq 'GET' -and $path -eq '/api/bloqueados') {
            Write-Log '    -> Buscando contas bloqueadas...' 'Yellow'
            $result = Get-LockedUsers
            $cor    = if ($result.users.Count -gt 0) { 'Yellow' } else { 'Green' }
            Write-Log "    -> $($result.users.Count) bloqueado(s)" $cor
            Send-Json $ctx 200 $result
            continue
        }

        if ($method -eq 'POST' -and $path -eq '/api/desbloquear') {
            $body   = Read-JsonBody $ctx
            Write-Log "    -> Desbloqueando: $($body.sam)" 'Yellow'
            $result = Invoke-DesbloquearUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    -> $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        if ($method -eq 'POST' -and $path -eq '/api/m365/conectar') {
            Write-Log '    -> Tentando conectar ao M365 (Exchange & Graph)...' 'Yellow'
            $result = Invoke-ConectarM365
            if ($result.success) {
                $script:M365GroupsCache.Timestamp = [datetime]::MinValue
                $script:M365LicensesCache.Timestamp = [datetime]::MinValue
            }
            $color  = $(if ($result.success) { 'Green' } else { 'Red' })
            Write-Log "    -> Conectado ao M365: $($result.success)" $color
            Send-Json $ctx 200 $result
            continue
        }

        if ($method -eq 'GET' -and $path -eq '/api/m365/status') {
            $result = Get-M365Status
            Send-Json $ctx 200 $result
            continue
        }

        if ($method -eq 'GET' -and $path -eq '/api/m365/grupos') {
            $result = Get-M365GruposCached
            Send-Json $ctx 200 $result
            continue
        }

        if ($method -eq 'GET' -and $path -eq '/api/m365/licencas') {
            $result = Get-M365LicencasCached
            Send-Json $ctx 200 $result
            continue
        }

        if ($method -eq 'POST' -and $path -eq '/api/m365/aplicar') {
            $body = Read-JsonBody $ctx
            Write-Log "    -> Aplicando licenças/grupos M365 para: $($body.userPrincipalName)" 'Yellow'
            $result = Invoke-AplicarM365 $body
            if ($result.success) {
                $script:M365LicensesCache.Timestamp = [datetime]::MinValue
            }
            $color  = $(if ($result.success) { 'Green' } else { 'Red' })
            Write-Log "    -> Resultado M365 aplicar: $($result.success)" $color
            Send-Json $ctx 200 $result
            continue
        }

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
