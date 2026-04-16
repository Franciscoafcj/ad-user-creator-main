<#
.SYNOPSIS
    Servidor HTTP local — AD User Creator
    Permite executar scripts de criação de usuários AD diretamente do navegador.

.DESCRIPTION
    Inicia um mini servidor HTTP na porta 7510 (apenas localhost).
    O navegador envia o script PS1 gerado e recebe a saída da execução em tempo real.

    Endpoints:
      GET  /api/ping  — verifica disponibilidade e retorna token de sessão
      POST /api/run   — executa o script recebido no corpo e devolve a saída

    Segurança:
      - Escuta APENAS em localhost (sem exposição na rede)
      - Token aleatório gerado a cada inicialização
      - Token é retornado via /api/ping e validado em /api/run

.NOTES
    Execute como Domain Admin para criar usuários no AD.
    Requer: Windows PowerShell 5.1+

.EXAMPLE
    .\Start-Server.ps1

.EXAMPLE
    .\Start-Server.ps1 -Port 8080
#>

#Requires -Version 5.1
[CmdletBinding()]
param(
    [int]$Port = 7510
)

$ErrorActionPreference = 'Stop'

# ══════════════════════════════════════════════════════════════════
# BANNER
# ══════════════════════════════════════════════════════════════════
Clear-Host
Write-Host ""
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ⚡  AD User Creator — Servidor Local                     " -ForegroundColor Cyan
Write-Host "  🌐  http://localhost:$Port                               " -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── Verificação de privilégios ──────────────────────────────────────────
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$whoami    = "$env:USERDOMAIN\$env:USERNAME"

$adminStatus = if ($isAdmin) { "Sim ✅" } else { "Não ⚠  (operações AD podem falhar sem privilégios)" }
$adminColor  = if ($isAdmin) { 'Green' } else { 'Yellow' }

Write-Host "  Usuário   : $whoami" -ForegroundColor White
Write-Host "  Admin     : $adminStatus" -ForegroundColor $adminColor
Write-Host ""

# ══════════════════════════════════════════════════════════════════
# TOKEN DE SESSÃO
# ══════════════════════════════════════════════════════════════════
$Token = [System.Guid]::NewGuid().ToString('N')

# ══════════════════════════════════════════════════════════════════
# INICIAR LISTENER
# ══════════════════════════════════════════════════════════════════
$Listener = [System.Net.HttpListener]::new()
$Listener.Prefixes.Add("http://localhost:$Port/")

try {
    $Listener.Start()
} catch {
    Write-Host "  ❌ Não foi possível iniciar na porta $Port" -ForegroundColor Red
    Write-Host "     Erro: $_" -ForegroundColor DarkRed
    Write-Host "     Verifique se outra instância já está em execução." -ForegroundColor DarkRed
    Read-Host "  Pressione Enter para sair"
    exit 1
}

Write-Host "  ✅ Servidor iniciado em http://localhost:$Port" -ForegroundColor Green
Write-Host ""
Write-Host "  Abra o index.html no navegador e clique em '▶ Executar'." -ForegroundColor White
Write-Host ""
Write-Host "  [Pressione Ctrl+C para encerrar]" -ForegroundColor DarkGray
Write-Host ""

# ══════════════════════════════════════════════════════════════════
# HELPER — Enviar resposta JSON
# ══════════════════════════════════════════════════════════════════
function Send-Json {
    param(
        [System.Net.HttpListenerContext]$Ctx,
        [int]   $Status = 200,
        [object]$Body   = @{}
    )
    $json  = $Body | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

    $r = $Ctx.Response
    $r.StatusCode      = $Status
    $r.ContentType     = 'application/json; charset=utf-8'
    $r.ContentLength64 = $bytes.Length
    $r.Headers.Add('Access-Control-Allow-Origin',  '*')
    $r.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $r.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
    $r.Headers.Add('Cache-Control', 'no-store')

    try { $r.OutputStream.Write($bytes, 0, $bytes.Length) } catch {}
    try { $r.OutputStream.Close() } catch {}
}

# ══════════════════════════════════════════════════════════════════
# LOOP PRINCIPAL
# ══════════════════════════════════════════════════════════════════
try {
    while ($Listener.IsListening) {

        # Aguarda próxima requisição
        $ctx = $null
        try { $ctx = $Listener.GetContext() } catch { break }

        $req    = $ctx.Request
        $path   = $req.Url.AbsolutePath.ToLower().TrimEnd('/')
        $method = $req.HttpMethod.ToUpper()

        Write-Host "  $(Get-Date -Format 'HH:mm:ss')  $method $path" -ForegroundColor DarkGray

        # ── CORS Preflight ──────────────────────────────────────────────
        if ($method -eq 'OPTIONS') {
            $ctx.Response.StatusCode = 204
            $ctx.Response.Headers.Add('Access-Control-Allow-Origin',  '*')
            $ctx.Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            $ctx.Response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, X-Server-Token')
            try { $ctx.Response.OutputStream.Close() } catch {}
            continue
        }

        # ══════════════════════════════════════════════════════════════
        # GET /api/ping — health check + token de sessão
        # ══════════════════════════════════════════════════════════════
        if ($method -eq 'GET' -and $path -eq '/api/ping') {
            Send-Json $ctx 200 @{
                status  = 'ok'
                token   = $Token
                user    = $whoami
                isAdmin = $isAdmin
                port    = $Port
            }
            continue
        }

        # ── Validar token para rotas protegidas ─────────────────────────
        $reqToken = $req.Headers['X-Server-Token']
        if ($reqToken -ne $Token) {
            Send-Json $ctx 401 @{ error = 'Token inválido ou ausente.' }
            Write-Host "    ⚠  Token inválido — requisição rejeitada" -ForegroundColor Yellow
            continue
        }

        # ══════════════════════════════════════════════════════════════
        # POST /api/run — executa o script PowerShell recebido
        # ══════════════════════════════════════════════════════════════
        if ($method -eq 'POST' -and $path -eq '/api/run') {

            $reader  = [System.IO.StreamReader]::new($req.InputStream, [System.Text.Encoding]::UTF8)
            $rawBody = $reader.ReadToEnd()
            $reader.Dispose()

            $tmpFile = $null
            try {
                $payload       = $rawBody | ConvertFrom-Json
                $scriptContent = $payload.script

                if ([string]::IsNullOrWhiteSpace($scriptContent)) {
                    throw 'Campo "script" está vazio ou ausente.'
                }

                # Grava script em arquivo temporário
                $tmpName = "adcreator_$([System.Guid]::NewGuid().ToString('N').Substring(0,8)).ps1"
                $tmpFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), $tmpName)
                [System.IO.File]::WriteAllText($tmpFile, $scriptContent, [System.Text.Encoding]::UTF8)

                Write-Host "    → Executando: $tmpFile" -ForegroundColor Yellow

                # ── Configurar processo filho ──────────────────────────
                $psi = [System.Diagnostics.ProcessStartInfo]::new()
                $psi.FileName               = 'powershell.exe'
                $psi.Arguments              = "-NoLogo -NonInteractive -ExecutionPolicy Bypass -File `"$tmpFile`""
                $psi.RedirectStandardOutput = $true
                $psi.RedirectStandardError  = $true
                $psi.UseShellExecute        = $false
                $psi.CreateNoWindow         = $true
                $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
                $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8

                # ── Capturar saída de forma assíncrona (evita deadlock) ─
                $outLines = [System.Collections.Generic.List[string]]::new()
                $errLines = [System.Collections.Generic.List[string]]::new()

                $proc = [System.Diagnostics.Process]::new()
                $proc.StartInfo = $psi

                $outJob = Register-ObjectEvent -InputObject $proc `
                    -EventName OutputDataReceived `
                    -MessageData $outLines `
                    -Action {
                        if ($null -ne $EventArgs.Data) {
                            $Event.MessageData.Add($EventArgs.Data)
                        }
                    }

                $errJob = Register-ObjectEvent -InputObject $proc `
                    -EventName ErrorDataReceived `
                    -MessageData $errLines `
                    -Action {
                        if ($null -ne $EventArgs.Data) {
                            $Event.MessageData.Add("⚠  STDERR: $($EventArgs.Data)")
                        }
                    }

                $proc.Start()            | Out-Null
                $proc.BeginOutputReadLine()
                $proc.BeginErrorReadLine()

                # Aguarda finalização (timeout 5 min)
                $ok = $proc.WaitForExit(300000)
                if (-not $ok) {
                    $proc.Kill()
                    throw 'Timeout de 5 minutos atingido. Script cancelado.'
                }

                Start-Sleep -Milliseconds 300   # Aguarda eventos restantes
                Unregister-Event -SourceIdentifier $outJob.Name -ErrorAction SilentlyContinue
                Unregister-Event -SourceIdentifier $errJob.Name -ErrorAction SilentlyContinue
                $outJob | Remove-Job -Force -ErrorAction SilentlyContinue
                $errJob | Remove-Job -Force -ErrorAction SilentlyContinue

                $exitCode = $proc.ExitCode
                $allLines = @($outLines) + @($errLines) | Where-Object { $_ -ne $null }

                $success = $exitCode -eq 0
                $color   = if ($success) { 'Green' } else { 'Red' }
                Write-Host "    → Código de saída: $exitCode — $($allLines.Count) linha(s)" -ForegroundColor $color

                Send-Json $ctx 200 @{
                    success  = $success
                    exitCode = $exitCode
                    lines    = @($allLines)
                }

            } catch {
                $errMsg = $_.Exception.Message
                Write-Host "    ❌ Erro: $errMsg" -ForegroundColor Red

                Unregister-Event -SourceIdentifier $outJob.Name -ErrorAction SilentlyContinue
                Unregister-Event -SourceIdentifier $errJob.Name -ErrorAction SilentlyContinue
                $outJob | Remove-Job -Force -ErrorAction SilentlyContinue
                $errJob | Remove-Job -Force -ErrorAction SilentlyContinue

                Send-Json $ctx 500 @{
                    success  = $false
                    exitCode = -1
                    lines    = @("❌ Erro interno do servidor: $errMsg")
                }
            } finally {
                if ($tmpFile -and (Test-Path $tmpFile -ErrorAction SilentlyContinue)) {
                    Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
                }
            }
            continue
        }

        # ── 404 ────────────────────────────────────────────────────────
        Send-Json $ctx 404 @{ error = "Rota não encontrada: $method $path" }
    }

} catch {
    Write-Host ""
    Write-Host "  Erro fatal: $_" -ForegroundColor Red
} finally {
    try { $Listener.Stop() } catch {}
    try { $Listener.Close() } catch {}
    Write-Host ""
    Write-Host "  Servidor encerrado." -ForegroundColor Yellow
    Write-Host ""
}
