<#
.SYNOPSIS
    Exporta informações do Active Directory (domínio + OUs + usuários) para um arquivo JS
    consumido pela interface web AD User Creator.

.DESCRIPTION
    Usa as credenciais do usuário Windows atualmente logado para:
    - Obter o domínio AD (DNS root, DN, NetBIOS)
    - Listar todas as Unidades Organizacionais (OUs)
    - Listar todos os usuários habilitados (para o campo Usuário Modelo)
    - Gravar o resultado em ad-data.js na mesma pasta do script

    Basta executar este script UMA VEZ antes de abrir o index.html.
    Sempre que a estrutura do AD mudar, execute novamente para atualizar.

.NOTES
    Requer o módulo ActiveDirectory (RSAT) instalado.
    O usuário logado precisa ter permissão de leitura no AD.

.EXAMPLE
    .\Get-ADData.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ══════════════════════════════════════════════════════════════════
# BANNER
# ══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "   AD User Creator — Exportar Dados do AD              " -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── Identidade do usuário logado ─────────────────────────────────
$currentUser     = $env:USERNAME
$currentDomain   = $env:USERDOMAIN
Write-Host "Usuário logado : $currentDomain\$currentUser" -ForegroundColor Yellow
Write-Host ""

# ══════════════════════════════════════════════════════════════════
# IMPORTAR MÓDULO
# ══════════════════════════════════════════════════════════════════
Write-Host "[ 1/4 ] Importando módulo ActiveDirectory..." -NoNewline
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " FALHOU" -ForegroundColor Red
    Write-Error @"
Módulo ActiveDirectory não encontrado.
Instale as RSAT (Remote Server Administration Tools):
  Windows 10/11: Configurações > Aplicativos > Recursos opcionais > RSAT: Active Directory
  ou via PowerShell (admin): Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0
"@
    exit 1
}

# ══════════════════════════════════════════════════════════════════
# COLETAR DADOS DO DOMÍNIO
# ══════════════════════════════════════════════════════════════════
Write-Host "[ 2/4 ] Coletando informações do domínio..." -NoNewline
try {
    $adDomain = Get-ADDomain -ErrorAction Stop
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " FALHOU" -ForegroundColor Red
    Write-Error "Não foi possível conectar ao AD. Verifique a conectividade com o controlador de domínio. Erro: $_"
    exit 1
}

$dnsRoot     = $adDomain.DNSRoot          # ex: orsegups.com.br
$netBiosName = $adDomain.NetBIOSName      # ex: ORSEGUPS
$distinguishedName = $adDomain.DistinguishedName  # ex: DC=orsegups,DC=com,DC=br
$domainControllers = @($adDomain.PDCEmulator)

Write-Host "   Domínio    : $dnsRoot ($netBiosName)" -ForegroundColor Gray
Write-Host "   DN         : $distinguishedName" -ForegroundColor Gray

# ══════════════════════════════════════════════════════════════════
# COLETAR OUs
# ══════════════════════════════════════════════════════════════════
Write-Host "[ 3/4 ] Coletando Unidades Organizacionais..." -NoNewline
try {
    $allOUs = Get-ADOrganizationalUnit -Filter * `
                  -Properties Name, DistinguishedName, Description, ProtectedFromAccidentalDeletion `
                  -ErrorAction Stop |
              Sort-Object DistinguishedName |
              Select-Object Name, DistinguishedName, @{n='Description';e={ $_.Description }}

    Write-Host " OK ($($allOUs.Count) OUs encontradas)" -ForegroundColor Green
} catch {
    Write-Host " FALHOU" -ForegroundColor Red
    Write-Error "Erro ao listar OUs: $_"
    exit 1
}

# ══════════════════════════════════════════════════════════════════
# COLETAR USUÁRIOS DO AD
# ══════════════════════════════════════════════════════════════════
Write-Host "[ 4/4 ] Coletando usuários do domínio..." -NoNewline
try {
    $allUsers = Get-ADUser -Filter * `
                    -Properties Name, DisplayName, SamAccountName, UserPrincipalName, EmailAddress, Title, Department, Enabled, DistinguishedName, MemberOf `
                    -ErrorAction Stop |
                Sort-Object Name

    Write-Host " OK ($($allUsers.Count) usuários encontrados)" -ForegroundColor Green
} catch {
    Write-Host " FALHOU (não crítico)" -ForegroundColor Yellow
    Write-Warning "Não foi possível listar usuários: $_"
    $allUsers = @()
}

# ══════════════════════════════════════════════════════════════════
# SERIALIZAR PARA JSON → ad-data.js
# ══════════════════════════════════════════════════════════════════
$ouList = $allOUs | ForEach-Object {
    [PSCustomObject]@{
        name              = $_.Name
        distinguishedName = $_.DistinguishedName
        description       = if ($_.Description) { $_.Description } else { '' }
    }
}

$userList = $allUsers | ForEach-Object {
    # Extrai a OU do DistinguishedName do usuário (remove o primeiro CN= e pega o restante)
    $userDn  = $_.DistinguishedName
    $userOu  = if ($userDn -match ',(.+)$') { $Matches[1] } else { '' }

    # Extrai apenas o nome de cada grupo (CN=) de MemberOf, excluindo Domain Users
    $grupos = if ($_.MemberOf) {
        @($_.MemberOf | ForEach-Object {
            if ($_ -match '^CN=([^,]+)') { $Matches[1] }
        } | Where-Object { $_ -and $_ -ne 'Domain Users' })
    } else { @() }

    [PSCustomObject]@{
        name               = $_.Name
        samAccountName     = $_.SamAccountName
        userPrincipalName  = if ($_.UserPrincipalName) { $_.UserPrincipalName } else { '' }
        emailAddress       = if ($_.EmailAddress)      { $_.EmailAddress }      else { '' }
        displayName        = if ($_.DisplayName)       { $_.DisplayName }       elseif ($_.Name) { $_.Name } else { $_.SamAccountName }
        title              = if ($_.Title)              { $_.Title }             else { '' }
        department         = if ($_.Department)         { $_.Department }        else { '' }
        enabled            = if ($_.Enabled -eq $true)  { $true }                else { $false }
        distinguishedName  = $userDn
        ou                 = $userOu
        groups             = $grupos
    }
}

$payload = [PSCustomObject]@{
    domain = [PSCustomObject]@{
        dnsRoot            = $dnsRoot
        netBiosName        = $netBiosName
        distinguishedName  = $distinguishedName
        domainControllers  = $domainControllers
    }
    currentUser = [PSCustomObject]@{
        samAccountName = $currentUser
        domainNetBios  = $currentDomain
        displayName    = "$currentDomain\$currentUser"
    }
    ous         = @($ouList)
    users       = @($userList)
    generatedAt = (Get-Date).ToString('o')   # ISO 8601
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress

$jsContent = @"
// ================================================================
// ad-data.js — Gerado automaticamente por Get-ADData.ps1
// Domínio  : $dnsRoot
// Gerado em: $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')
// Usuário  : $currentDomain\$currentUser
// NÃO EDITE MANUALMENTE — execute Get-ADData.ps1 para atualizar
// ================================================================
window.AD_DATA = $json;
"@

$outputPath = Join-Path $PSScriptRoot 'ad-data.js'
Set-Content -Path $outputPath -Value $jsContent -Encoding UTF8

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Arquivo gerado: $outputPath" -ForegroundColor Green
Write-Host "  Domínio       : $dnsRoot" -ForegroundColor Green
Write-Host "  OUs exportadas : $($allOUs.Count)" -ForegroundColor Green
Write-Host "  Usuários exp.  : $($allUsers.Count)" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "Agora abra o index.html no navegador." -ForegroundColor Yellow
Write-Host ""
