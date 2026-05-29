<#
.SYNOPSIS
    AD User Creator — Servidor Unificado

.DESCRIPTION
    Um único arquivo que centraliza tudo: servidor HTTP + lógica de AD.
    Não são necessários scripts externos — tudo roda aqui dentro.

    Endpoints disponíveis:
      GET  /api/ping              → health check + token de sessão
      GET  /api/ad-data           → OUs e usuários do AD (ao vivo)
      POST /api/criar-usuario     → cria usuário no AD (JSON)
      POST /api/criar-lote        → cria vários usuários (JSON array)
      POST /api/desabilitar       → desabilita uma conta (JSON)
      POST /api/desabilitar-lote  → desabilita várias contas (JSON)
      GET  /api/bloqueados        → lista usuários com conta bloqueada
      POST /api/desbloquear       → desbloqueia uma conta (JSON)

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

# ══════════════════════════════════════════════════════════════════
# 1. CONFIGURAÇÃO — lê config.json, define defaults
# ══════════════════════════════════════════════════════════════════
$ConfigFile = Join-Path $PSScriptRoot 'config.json'
$Cfg = @{
    serverPort     = 7510
    dominioEmail   = 'orsegups.com.br'
    ouPadrao       = ''
    logDirectory   = 'logs'
    abrirNavegador = $true
}

if (Test-Path $ConfigFile) {
    try {
        $json = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($json.serverPort)     { $Cfg.serverPort     = [int]$json.serverPort }
        if ($json.dominioEmail)   { $Cfg.dominioEmail   = [string]$json.dominioEmail }
        if ($json.ouPadrao)       { $Cfg.ouPadrao       = [string]$json.ouPadrao }
        if ($json.logDirectory)   { $Cfg.logDirectory   = [string]$json.logDirectory }
        if ($null -ne $json.abrirNavegador) { $Cfg.abrirNavegador = [bool]$json.abrirNavegador }
    } catch {
        Write-Warning "Falha ao ler config.json: $_"
    }
}

# Parâmetro de linha de comando sobrepõe o config
if ($Port -gt 0) { $Cfg.serverPort = $Port }

# ── Logging ──────────────────────────────────────────────────────
$LogPath = Join-Path $PSScriptRoot $Cfg.logDirectory
if (-not (Test-Path $LogPath)) { New-Item -ItemType Directory -Path $LogPath | Out-Null }
$LogFile = Join-Path $LogPath "server-$(Get-Date -Format 'yyyy-MM-dd').log"

function Write-Log {
    param([string]$Message, [string]$Color = 'White')
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "  $ts  $Message" -ForegroundColor $Color
    Add-Content -Path $LogFile -Value "[$ts] $Message" -ErrorAction SilentlyContinue
}

# ── Banner ────────────────────────────────────────────────────────
Clear-Host
Write-Host ''
Write-Host '═══════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host "  ⚡  AD User Creator — Servidor Unificado              " -ForegroundColor Cyan
Write-Host "  🌐  http://localhost:$($Cfg.serverPort)               " -ForegroundColor Cyan
Write-Host '═══════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''

# ── Verificação de privilégios ────────────────────────────────────
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$whoami    = "$env:USERDOMAIN\$env:USERNAME"

$adminTxt = if ($isAdmin) { 'Sim ✅' } else { 'Não ⚠  (operações AD podem falhar sem privilégios)' }
$adminClr = if ($isAdmin) { 'Green' } else { 'Yellow' }

Write-Host "  Usuário  : $whoami"   -ForegroundColor White
Write-Host "  Admin    : $adminTxt" -ForegroundColor $adminClr
Write-Host ''

# ══════════════════════════════════════════════════════════════════
# 2. MÓDULO DO ACTIVE DIRECTORY
# ══════════════════════════════════════════════════════════════════
$ADModuleLoaded = $false
try {
    Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
    $ADModuleLoaded = $true
    Write-Host '  Módulo ActiveDirectory carregado ✅' -ForegroundColor Green
} catch {
    Write-Host '  ⚠  Módulo ActiveDirectory não encontrado.' -ForegroundColor Yellow
    Write-Host '     Instale as RSAT Tools para habilitar operações no AD.' -ForegroundColor DarkGray
}
Write-Host ''

# ══════════════════════════════════════════════════════════════════
# 3. FUNÇÕES AUXILIARES DE AD
# ══════════════════════════════════════════════════════════════════

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

# ── Criar usuário no AD ───────────────────────────────────────────
function Invoke-CriarUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }

        # ── Validações ──────────────────────────────────────────────
        if (-not $Data.sam)   { throw 'Campo "sam" é obrigatório.' }
        if (-not $Data.email) { throw 'Campo "email" é obrigatório.' }
        if (-not $Data.senha) { throw 'Campo "senha" é obrigatório.' }
        if (-not $Data.nome)  { throw 'Campo "nome" é obrigatório.' }

        # ── CPF ─────────────────────────────────────────────────────
        $cpf11 = if ($Data.cpf) { Normalizar-CPF ([string]$Data.cpf) } else { '00000000000' }
        if (-not $cpf11) { throw "CPF inválido: '$($Data.cpf)'" }
        if (-not (Validar-CPF $cpf11)) {
            $linhas.Add("⚠  CPF '$cpf11' não passou na validação dos dígitos verificadores — prosseguindo.")
        }

        # ── OU ──────────────────────────────────────────────────────
        $ouFinal = if ($Data.ou) { [string]$Data.ou }
                   elseif ($Cfg.ouPadrao) { $Cfg.ouPadrao }
                   else {
                       $dom = (Get-ADDomain).DistinguishedName
                       "OU=Usuarios,$dom"
                   }

        # ── Verificar conflitos ──────────────────────────────────────
        if (Get-ADUser -Filter "SamAccountName -eq '$($Data.sam)'" -ErrorAction SilentlyContinue) {
            throw "Login '$($Data.sam)' já existe no AD."
        }
        if (Get-ADUser -Filter "UserPrincipalName -eq '$($Data.email)'" -ErrorAction SilentlyContinue) {
            throw "E-mail/UPN '$($Data.email)' já existe na floresta."
        }

        # ── Nome completo ────────────────────────────────────────────
        $nomeCompleto = if ($Data.nomeCompleto) { [string]$Data.nomeCompleto }
                        elseif ($Data.sobrenome) { "$($Data.nome) $($Data.sobrenome)" }
                        else { [string]$Data.nome }

        # ── Criar ────────────────────────────────────────────────────
        $senha  = ConvertTo-SecureString ([string]$Data.senha) -AsPlainText -Force
        $params = @{
            Name                  = $nomeCompleto
            GivenName             = [string]$Data.nome
            Surname               = if ($Data.sobrenome) { [string]$Data.sobrenome } else { '' }
            SamAccountName        = [string]$Data.sam
            UserPrincipalName     = [string]$Data.email
            EmailAddress          = [string]$Data.email
            Description           = $cpf11
            Path                  = $ouFinal
            AccountPassword       = $senha
            Enabled               = [bool](if ($null -ne $Data.habilitado) { $Data.habilitado } else { $true })
            ChangePasswordAtLogon = [bool](if ($null -ne $Data.trocarSenha) { $Data.trocarSenha } else { $true })
        }

        if ($Data.departamento) { $params.Department = [string]$Data.departamento }
        if ($Data.cargo)        { $params.Title      = [string]$Data.cargo }

        New-ADUser @params

        $linhas.Add("✅ Usuário '$nomeCompleto' criado com sucesso!")
        $linhas.Add("   Login  : $($Data.sam)")
        $linhas.Add("   E-mail : $($Data.email)")
        $linhas.Add("   CPF(AD): $cpf11")
        if ($Data.departamento) { $linhas.Add("   Depto  : $($Data.departamento)") }

        # ── Copiar grupos do usuário modelo ─────────────────────────
        if ($Data.usuarioModelo) {
            try {
                $grupos = Get-ADPrincipalGroupMembership -Identity ([string]$Data.usuarioModelo) |
                          Where-Object { $_.Name -ne 'Domain Users' }
                if ($grupos.Count -gt 0) {
                    $linhas.Add("   🔗 Copiando $($grupos.Count) grupo(s) de '$($Data.usuarioModelo)'...")
                    foreach ($g in $grupos) {
                        try {
                            Add-ADGroupMember -Identity $g.DistinguishedName -Members ([string]$Data.sam) -ErrorAction Stop
                            $linhas.Add("      ✅ $($g.Name)")
                        } catch {
                            $linhas.Add("      ⚠  $($g.Name): $($_.Exception.Message)")
                        }
                    }
                }
            } catch {
                $linhas.Add("   ⚠  Não foi possível copiar grupos: $($_.Exception.Message)")
            }
        }

        $sucesso = $true

    } catch {
        $linhas.Add("❌ Erro: $($_.Exception.Message)")
    }

    return @{ success = $sucesso; lines = @($linhas) }
}

# ── Desabilitar usuário ───────────────────────────────────────────
function Invoke-DesabilitarUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }
        if (-not $Data.sam) { throw 'Campo "sam" é obrigatório.' }

        $user = Get-ADUser -Identity ([string]$Data.sam) -ErrorAction Stop
        Disable-ADAccount -Identity ([string]$Data.sam) -ErrorAction Stop
        $linhas.Add("✅ Conta '$($Data.sam)' desabilitada com sucesso!")

        if ($Data.expirarSenha -eq $true) {
            Set-ADUser -Identity ([string]$Data.sam) -PasswordNeverExpires $false -ChangePasswordAtLogon $true -ErrorAction SilentlyContinue
            $linhas.Add("   🔑 Senha expirada.")
        }

        if ($Data.moverOu -eq $true -and $Data.ouDestino) {
            Move-ADObject -Identity $user.DistinguishedName -TargetPath ([string]$Data.ouDestino) -ErrorAction Stop
            $linhas.Add("   📂 Movido para: $($Data.ouDestino)")
        }

        if ($Data.motivo) {
            $hoje = (Get-Date).ToString('dd/MM/yyyy')
            Set-ADUser -Identity ([string]$Data.sam) -Description "DESABILITADO em $hoje - $($Data.motivo)" -ErrorAction SilentlyContinue
            $linhas.Add("   📝 Motivo registrado na descrição.")
        }

        $sucesso = $true

    } catch {
        $linhas.Add("❌ Erro: $($_.Exception.Message)")
    }

    return @{ success = $sucesso; lines = @($linhas) }
}

# ── Buscar dados do AD ao vivo ────────────────────────────────────
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
        # ── Domínio ─────────────────────────────────────────────────
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

        # ── OUs ─────────────────────────────────────────────────────
        $allOUs = Get-ADOrganizationalUnit -Filter * `
                      -Properties Name, DistinguishedName, Description `
                      -ErrorAction Stop |
                  Sort-Object DistinguishedName |
                  ForEach-Object {
                      @{
                          name              = $_.Name
                          distinguishedName = $_.DistinguishedName
                          description       = if ($_.Description) { $_.Description } else { '' }
                      }
                  }
        $result.ous = @($allOUs)

        # ── Usuários ─────────────────────────────────────────────────
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
                            userPrincipalName = if ($_.UserPrincipalName) { $_.UserPrincipalName } else { '' }
                            emailAddress      = if ($_.EmailAddress)      { $_.EmailAddress }      else { '' }
                            displayName       = if ($_.DisplayName)       { $_.DisplayName }       elseif ($_.Name) { $_.Name } else { $_.SamAccountName }
                            title             = if ($_.Title)      { $_.Title }      else { '' }
                            department        = if ($_.Department) { $_.Department } else { '' }
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

# ── Usuários com conta bloqueada ──────────────────────────────────
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
                display    = if ($_.DisplayName) { [string]$_.DisplayName } else { [string]$_.SamAccountName }
                department = if ($_.Department) { [string]$_.Department } else { '' }
                title      = if ($_.Title)      { [string]$_.Title }      else { '' }
                badCount   = [int]$(if ($_.BadLogonCount) { $_.BadLogonCount } else { 0 })
                lastBad    = if ($_.LastBadPasswordAttempt) { $_.LastBadPasswordAttempt.ToString('dd/MM/yyyy HH:mm:ss') } else { '' }
                enabled    = ($_.Enabled -eq $true)
            }
        })
        $result.success = $true

    } catch {
        $result.error = $_.Exception.Message
    }

    return $result
}

# ── Desbloquear usuário ───────────────────────────────────────────
function Invoke-DesbloquearUsuario {
    param([hashtable]$Data)

    $linhas  = [System.Collections.Generic.List[string]]::new()
    $sucesso = $false

    try {
        if (-not $ADModuleLoaded) { throw 'Módulo ActiveDirectory não disponível.' }
        if (-not $Data.sam) { throw 'Campo "sam" é obrigatório.' }

        Unlock-ADAccount -Identity ([string]$Data.sam) -ErrorAction Stop
        $linhas.Add("✅ Conta '$($Data.sam)' desbloqueada com sucesso!")

        $u = Get-ADUser -Identity ([string]$Data.sam) -Properties LockedOut -ErrorAction SilentlyContinue
        if ($u -and -not $u.LockedOut) { $linhas.Add('   Verificado: conta agora desbloqueada.') }

        $sucesso = $true

    } catch {
        $linhas.Add("❌ Erro: $($_.Exception.Message)")
    }

    return @{ success = $sucesso; lines = @($linhas) }
}

# ══════════════════════════════════════════════════════════════════
# 4. SERVIDOR HTTP — inicialização
# ══════════════════════════════════════════════════════════════════
$Token    = [System.Guid]::NewGuid().ToString('N')
$Listener = [System.Net.HttpListener]::new()
$Listener.Prefixes.Add("http://localhost:$($Cfg.serverPort)/")

try {
    $Listener.Start()
} catch {
    Write-Host "  ❌ Não foi possível iniciar na porta $($Cfg.serverPort)" -ForegroundColor Red
    Write-Host "     Erro: $_" -ForegroundColor DarkRed
    Write-Host '     Verifique se outra instância já está em execução.' -ForegroundColor DarkGray
    Read-Host '  Pressione Enter para sair'
    exit 1
}

Write-Host "  ✅ Servidor iniciado em http://localhost:$($Cfg.serverPort)" -ForegroundColor Green
Write-Host ''
Write-Host '  [Pressione Ctrl+C para encerrar]' -ForegroundColor DarkGray
Write-Host ''

# Abre o navegador automaticamente (se configurado)
if ($Cfg.abrirNavegador) {
    $indexPath = Join-Path $PSScriptRoot 'index.html'
    if (Test-Path $indexPath) {
        try { Start-Process $indexPath } catch {}
    }
}

# ── Funções de resposta HTTP ──────────────────────────────────────
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

# ══════════════════════════════════════════════════════════════════
# 5. ROTEADOR — loop principal de requisições
# ══════════════════════════════════════════════════════════════════
try {
    while ($Listener.IsListening) {

        $ctx = $null
        try { $ctx = $Listener.GetContext() } catch { break }

        $req    = $ctx.Request
        $path   = $req.Url.AbsolutePath.ToLower().TrimEnd('/')
        $method = $req.HttpMethod.ToUpper()

        Write-Log "$method $path" 'DarkGray'

        # ── CORS Seguro ──────────────────────────────────────────────
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
            Write-Log '    ⚠  Requisição bloqueada por CORS' 'Yellow'
            continue
        }

        # ── GET /api/ping ─────────────────────────────────────────────
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

        # ── Validação de token para rotas protegidas ──────────────────
        $reqToken = $req.Headers['X-Server-Token']
        if ($reqToken -ne $Token) {
            Send-Json $ctx 401 @{ error = 'Token inválido ou ausente.' }
            Write-Log '    ⚠  Token inválido — requisição rejeitada' 'Yellow'
            continue
        }

        # ── GET /api/ad-data ──────────────────────────────────────────
        if ($method -eq 'GET' -and $path -eq '/api/ad-data') {
            Write-Log '    → Buscando dados do AD ao vivo...' 'Yellow'
            $data  = Get-ADInfo
            $color = if ($data.error) { 'Red' } else { 'Green' }
            Write-Log "    → $($data.ous.Count) OUs | $($data.users.Count) usuários" $color
            Send-Json $ctx 200 $data
            continue
        }

        # ── POST /api/criar-usuario ───────────────────────────────────
        if ($method -eq 'POST' -and $path -eq '/api/criar-usuario') {
            $body = Read-JsonBody $ctx
            Write-Log "    → Criando usuário: $($body.sam)" 'Yellow'
            $result = Invoke-CriarUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    → $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        # ── POST /api/criar-lote ──────────────────────────────────────
        if ($method -eq 'POST' -and $path -eq '/api/criar-lote') {
            $body     = Read-JsonBody $ctx
            $usuarios = @($body.usuarios)
            Write-Log "    → Criando $($usuarios.Count) usuário(s) em lote..." 'Yellow'

            $allLines = [System.Collections.Generic.List[string]]::new()
            $sucesso  = 0
            $falha    = 0

            foreach ($u in $usuarios) {
                $ut     = ConvertTo-SafeHashtable $u
                $r      = Invoke-CriarUsuario $ut
                $allLines.AddRange($r.lines)
                $allLines.Add('')
                if ($r.success) { $sucesso++ } else { $falha++ }
            }

            $allLines.Add("══ Resultado: $sucesso criado(s) | $falha erro(s) ══")
            Write-Log "    → Lote: $sucesso ok | $falha erro(s)" (if ($falha -gt 0) { 'Yellow' } else { 'Green' })

            Send-Json $ctx 200 @{
                success = ($falha -eq 0)
                sucesso = $sucesso
                falha   = $falha
                lines   = @($allLines)
            }
            continue
        }

        # ── POST /api/desabilitar ─────────────────────────────────────
        if ($method -eq 'POST' -and $path -eq '/api/desabilitar') {
            $body   = Read-JsonBody $ctx
            Write-Log "    → Desabilitando: $($body.sam)" 'Yellow'
            $result = Invoke-DesabilitarUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    → $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        # ── POST /api/desabilitar-lote ────────────────────────────────
        if ($method -eq 'POST' -and $path -eq '/api/desabilitar-lote') {
            $body     = Read-JsonBody $ctx
            $usuarios = @($body.usuarios)
            $opcoes   = @{
                motivo       = $body.motivo
                moverOu      = $body.moverOu
                ouDestino    = $body.ouDestino
                expirarSenha = $body.expirarSenha
            }
            Write-Log "    → Desabilitando $($usuarios.Count) conta(s) em lote..." 'Yellow'

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
                $r = Invoke-DesabilitarUsuario $ut
                $allLines.AddRange($r.lines)
                $allLines.Add('')
                if ($r.success) { $sucesso++ } else { $falha++ }
            }

            $allLines.Add("══ Resultado: $sucesso desabilitado(s) | $falha erro(s) ══")
            Write-Log "    → Lote: $sucesso ok | $falha erro(s)" (if ($falha -gt 0) { 'Yellow' } else { 'Green' })

            Send-Json $ctx 200 @{
                success = ($falha -eq 0)
                sucesso = $sucesso
                falha   = $falha
                lines   = @($allLines)
            }
            continue
        }

        # ── GET /api/bloqueados ───────────────────────────────────────
        if ($method -eq 'GET' -and $path -eq '/api/bloqueados') {
            Write-Log '    → Buscando contas bloqueadas...' 'Yellow'
            $result = Get-LockedUsers
            $cor    = if ($result.users.Count -gt 0) { 'Yellow' } else { 'Green' }
            Write-Log "    → $($result.users.Count) bloqueado(s)" $cor
            Send-Json $ctx 200 $result
            continue
        }

        # ── POST /api/desbloquear ─────────────────────────────────────
        if ($method -eq 'POST' -and $path -eq '/api/desbloquear') {
            $body   = Read-JsonBody $ctx
            Write-Log "    → Desbloqueando: $($body.sam)" 'Yellow'
            $result = Invoke-DesbloquearUsuario $body
            $color  = if ($result.success) { 'Green' } else { 'Red' }
            Write-Log "    → $($result.lines[0])" $color
            Send-Json $ctx 200 $result
            continue
        }

        # ── 404 ───────────────────────────────────────────────────────
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
