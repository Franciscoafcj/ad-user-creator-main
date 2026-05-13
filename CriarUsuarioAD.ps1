<#
.SYNOPSIS
    Criacao de usuarios no Active Directory com validacao de CPF e geração de e-mail.

.DESCRIPTION
    Este script pode ser executado de forma interativa ou em modo lote (CSV).
    - CPF: salvo no campo Description sem pontuacao, sempre com 11 digitos (zeros a esquerda se necessario)
    - E-mail: gerado automaticamente no formato primeiro.ultimo@orsegups.com.br
    - SamAccountName: gerado automaticamente no formato primeiro.ultimo

.PARAMETER Modo
    "interativo" (padrao) ou "lote"

.PARAMETER CaminhoCSV
    Caminho para o arquivo CSV (usado no modo lote)

.PARAMETER DominioEmail
    Dominio do e-mail. Padrao: orsegups.com.br

.PARAMETER OUPadrao
    OU padrao para criacao dos usuarios

.EXAMPLE
    # Modo interativo
    .\CriarUsuarioAD.ps1

.EXAMPLE
    # Modo lote com CSV
    .\CriarUsuarioAD.ps1 -Modo lote -CaminhoCSV C:\usuarios.csv

.NOTES
    Requer privilegios de Domain Admin.
    Importa o modulo ActiveDirectory automaticamente.
    
    Formato do CSV (com ou sem cabecalho):
    Nome,Sobrenome,CPF,Departamento,Cargo,OU,Senha
#>

param(
    [ValidateSet('interativo','lote')]
    [string]$Modo = 'interativo',

    [string]$CaminhoCSV,

    [string]$DominioEmail = 'orsegups.com.br',

    [string]$OUPadrao = $null
)

# ══════════════════════════════════════════════════════════════════
# IMPORTAR MÓDULO
# ══════════════════════════════════════════════════════════════════
# Suprime avisos inofensivos de TypeData que ocorrem no PS 5.1 ao carregar o módulo AD
try {
    Import-Module ActiveDirectory -ErrorAction Stop -WarningAction SilentlyContinue
    Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue
} catch {
    Write-Error "Modulo ActiveDirectory nao encontrado. Execute em um servidor AD ou instale as RSAT tools."
    exit 1
}

# ══════════════════════════════════════════════════════════════════
# FUNÇÕES AUXILIARES
# ══════════════════════════════════════════════════════════════════

function Remove-Acentos {
    param([string]$Texto)
    $Normalizado = $Texto.Normalize([System.Text.NormalizationForm]::FormD)
    $Saida = [System.Text.StringBuilder]::new()
    foreach ($c in $Normalizado.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$Saida.Append($c)
        }
    }
    return $Saida.ToString()
}

function Formatar-Login {
    param([string]$Nome, [string]$Sobrenome)
    $n = (Remove-Acentos $Nome).ToLower()     -replace '[^a-z0-9\.\-_]', ''
    $s = (Remove-Acentos $Sobrenome).ToLower() -replace '[^a-z0-9\.\-_]', ''
    return "$n.$s"
}

function Normalizar-CPF {
    <#
    .SYNOPSIS
        Remove pontuacao do CPF e preenche com zeros a esquerda ate 11 digitos.
        Aceita CPFs com ou sem pontuacao.
    #>
    param([string]$CPF)

    # Remove tudo que nao for digito
    $Digitos = $CPF -replace '\D', ''

    if ($Digitos.Length -gt 11) {
        Write-Warning "CPF '$CPF' possui mais de 11 digitos. Verificar."
        return $null
    }

    # Preenche com zeros a esquerda se necessario
    return $Digitos.PadLeft(11, '0')
}

function Validar-CPF {
    <#
    .SYNOPSIS
        Valida CPF pelo algoritmo oficial (digitos verificadores).
        Retorna $true ou $false.
    #>
    param([string]$CPF11)

    if ($CPF11.Length -ne 11) { return $false }
    # Sequencias invalidas (ex: 00000000000)
    if ($CPF11 -match '^(\d)\1{10}$') { return $false }

    $soma = 0
    for ($i = 0; $i -lt 9; $i++) { $soma += [int]::Parse($CPF11[$i]) * (10 - $i) }
    $resto = ($soma * 10) % 11
    if ($resto -eq 10 -or $resto -eq 11) { $resto = 0 }
    if ($resto -ne [int]::Parse($CPF11[9])) { return $false }

    $soma = 0
    for ($i = 0; $i -lt 10; $i++) { $soma += [int]::Parse($CPF11[$i]) * (11 - $i) }
    $resto = ($soma * 10) % 11
    if ($resto -eq 10 -or $resto -eq 11) { $resto = 0 }
    return $resto -eq [int]::Parse($CPF11[10])
}

function Criar-UsuarioAD {
    <#
    .SYNOPSIS
        Cria um usuario no Active Directory com todos os campos preenchidos.
    #>
    param(
        [Parameter(Mandatory)][string]$Nome,
        [Parameter(Mandatory)][string]$Sobrenome,
        [Parameter(Mandatory)][string]$CPF,
        [string]$Departamento = '',
        [string]$Cargo        = '',
        [string]$OU           = $null,
        [Parameter(Mandatory)][string]$SenhaTexto,
        [bool]$TrocarSenha    = $true,
        [bool]$Habilitado     = $true
    )

    # ── Normalizar CPF ───────────────────────────────────────────
    $CPF11 = Normalizar-CPF $CPF
    if (-not $CPF11) {
        Write-Error "CPF invalido para $Nome $Sobrenome. Abortando."
        return
    }

    $CPFValido = Validar-CPF $CPF11
    if (-not $CPFValido) {
        Write-Warning "CPF '$CPF11' nao passou na validacao dos digitos verificadores para $Nome $Sobrenome."
        Write-Warning "O usuario sera criado mesmo assim com o CPF informado."
    }

    # ── Gerar Login e E-mail ─────────────────────────────────────
    $NomeCompleto = "$Nome $Sobrenome"
    $Login        = Formatar-Login $Nome $Sobrenome
    $Email        = "$Login@$DominioEmail"

    # ── Definir OU ───────────────────────────────────────────────
    $OUFinal = if ($OU) { $OU } elseif ($OUPadrao) { $OUPadrao } else {
        # Detecta automaticamente o dominio do AD
        $Dominio = (Get-ADDomain).DistinguishedName
        "OU=Usuarios,$Dominio"
    }

    # ── Senha ────────────────────────────────────────────────────
    $SenhaSegura = ConvertTo-SecureString $SenhaTexto -AsPlainText -Force

    # ── Criar no AD ─────────────────────────────────────────────
    try {
        # Verifica se login (SAM) já existe
        if (Get-ADUser -Filter "SamAccountName -eq '$Login'" -ErrorAction SilentlyContinue) {
            Write-Warning "Usuario '$Login' ja existe no AD. Pulando."
            return
        }

        # Verifica se o UPN já existe em toda a floresta
        if (Get-ADUser -Filter "UserPrincipalName -eq '$Email'" -ErrorAction SilentlyContinue) {
            Write-Error "O UPN '$Email' ja existe na floresta do AD. Verifique o dominio ou use um sufixo UPN diferente."
            return
        }

        $Params = @{
            Name                  = $NomeCompleto
            GivenName             = $Nome
            Surname               = $Sobrenome
            SamAccountName        = $Login
            UserPrincipalName     = $Email
            EmailAddress          = $Email
            Description           = $CPF11       # CPF sem pontuacao, 11 digitos
            Department            = $Departamento
            Title                 = $Cargo
            Path                  = $OUFinal
            AccountPassword       = $SenhaSegura
            Enabled               = $Habilitado
            ChangePasswordAtLogon = $TrocarSenha
        }

        New-ADUser @Params

        Write-Host "OK  | $NomeCompleto" -ForegroundColor Green
        Write-Host "     Login   : $Login"
        Write-Host "     E-mail  : $Email"
        Write-Host "     CPF(AD) : $CPF11"
        if ($Departamento) { Write-Host "     Depto   : $Departamento" }
        Write-Host ""

    } catch {
        Write-Error "ERRO ao criar '$NomeCompleto': $($_.Exception.Message)"
    }
}

# ══════════════════════════════════════════════════════════════════
# MODO INTERATIVO
# ══════════════════════════════════════════════════════════════════
if ($Modo -eq 'interativo') {

    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "   CRIAÇÃO DE USUÁRIO — Active Directory            " -ForegroundColor Cyan
    Write-Host "   Orsegups Participações                           " -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""

    $Nome         = Read-Host "Nome"
    $Sobrenome    = Read-Host "Sobrenome"
    $CPFInput     = Read-Host "CPF (com ou sem pontuacao)"
    $Departamento = Read-Host "Departamento (Enter para pular)"
    $Cargo        = Read-Host "Cargo (Enter para pular)"
    $OUInput      = Read-Host "OU (Enter para usar padrao)"
    $Senha        = Read-Host "Senha inicial" -AsSecureString
    $SenhaTexto   = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Senha))

    $TrocarOpt = Read-Host "Forcar troca de senha no proximo login? (S/N) [S]"
    $TrocarSenha = $TrocarOpt -ne 'N'

    Write-Host ""
    Write-Host "─── Criando usuário... ───────────────────────────" -ForegroundColor DarkCyan

    Criar-UsuarioAD `
        -Nome          $Nome `
        -Sobrenome     $Sobrenome `
        -CPF           $CPFInput `
        -Departamento  $Departamento `
        -Cargo         $Cargo `
        -OU            $OUInput `
        -SenhaTexto    $SenhaTexto `
        -TrocarSenha   $TrocarSenha

    Write-Host "─── Concluido ────────────────────────────────────" -ForegroundColor DarkCyan
    Write-Host ""
}

# ══════════════════════════════════════════════════════════════════
# MODO LOTE (CSV)
# ══════════════════════════════════════════════════════════════════
elseif ($Modo -eq 'lote') {

    if (-not $CaminhoCSV -or -not (Test-Path $CaminhoCSV)) {
        Write-Error "Informe um caminho valido para o CSV com -CaminhoCSV"
        exit 1
    }

    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "   CRIAÇÃO EM LOTE — Active Directory               " -ForegroundColor Cyan
    Write-Host "   Arquivo: $CaminhoCSV                             " -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""

    # Tenta detectar se o CSV tem cabecalho
    $PrimeiraLinha = (Get-Content $CaminhoCSV -TotalCount 1).ToLower()
    $TemCabecalho  = $PrimeiraLinha -match 'nome|first|cpf|sobrenome'

    if ($TemCabecalho) {
        $Dados = Import-Csv $CaminhoCSV -Encoding UTF8
    } else {
        # Sem cabecalho: Nome,Sobrenome,CPF,Departamento,Cargo,OU,Senha
        $Dados = Import-Csv $CaminhoCSV -Header "Nome","Sobrenome","CPF","Departamento","Cargo","OU","Senha" -Encoding UTF8
    }

    $Total   = $Dados.Count
    $Sucesso = 0; $Falha = 0; $Contador = 0

    foreach ($linha in $Dados) {
        $Contador++
        $NomeLinha = "$($linha.Nome) $($linha.Sobrenome)"
        Write-Host "[$Contador/$Total] $NomeLinha" -NoNewline

        $Senha = if ($linha.Senha) { $linha.Senha } else { "Mudar@$(Get-Date -Format 'yyyy')" }

        try {
            Criar-UsuarioAD `
                -Nome         ($linha.Nome      ?? $linha.'First Name' ?? '') `
                -Sobrenome    ($linha.Sobrenome  ?? $linha.'Last Name'  ?? '') `
                -CPF          ($linha.CPF        ?? '') `
                -Departamento ($linha.Departamento ?? $linha.Department ?? '') `
                -Cargo        ($linha.Cargo      ?? $linha.Title        ?? '') `
                -OU           ($linha.OU         ?? '') `
                -SenhaTexto   $Senha
            $Sucesso++
        } catch {
            Write-Error " -> ERRO: $_"
            $Falha++
        }
    }

    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  Resultado: $Sucesso criado(s)  |  $Falha erro(s)" -ForegroundColor $(if($Falha -gt 0){'Yellow'}else{'Green'})
    Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
}
