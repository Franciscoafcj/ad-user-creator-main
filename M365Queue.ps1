# Persistent queue, executed in the server's authenticated PowerShell session.
# No credentials or passwords are stored here.
$script:M365QueueDirectory = Join-Path $PSScriptRoot 'data/m365-queue'
$script:M365QueueLastPoll = [datetime]::MinValue

function Save-M365QueueJob {
    param($Job)
    [void][System.IO.Directory]::CreateDirectory($script:M365QueueDirectory)
    $path = Join-Path $script:M365QueueDirectory "$($Job.id).json"
    $temp = "$path.tmp"
    [System.IO.File]::WriteAllText($temp, ($Job | ConvertTo-Json -Depth 12), [System.Text.Encoding]::UTF8)
    if ([System.IO.File]::Exists($path)) {
        [System.IO.File]::Replace($temp, $path, "$path.bak")
    } else {
        [System.IO.File]::Move($temp, $path)
    }
}

function Get-M365QueueJobs {
    if (-not (Test-Path $script:M365QueueDirectory)) { return }
    foreach ($file in Get-ChildItem -LiteralPath $script:M365QueueDirectory -Filter '*.json') {
        try { Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
        catch { Write-Log "[M365 Queue] Cannot read $($file.Name): $_" 'Red' }
    }
}

function New-M365QueueJob {
    param([string]$Upn, [string]$ObjectGuid, [hashtable]$Selection, [datetime]$CreatedAt)
    $steps = @()
    foreach ($sku in @($Selection.licenses)) {
        if ($sku) { $steps += @{ kind = 'license'; id = [string]$sku; name = [string]$sku; source = 'Graph'; done = $false } }
    }
    foreach ($group in @($Selection.groups)) {
        if ($group.id -and $group.source -in @('Graph', 'Exchange')) {
            $steps += @{ kind = 'group'; id = [string]$group.id; name = [string]$group.name; source = [string]$group.source; done = $false }
        } else { throw 'Invalid M365 group selection.' }
    }
    if (-not $steps.Count) { return $null }
    $job = [pscustomobject]@{
        id = [guid]::NewGuid().ToString('N'); userPrincipalName = $Upn; objectGuid = $ObjectGuid
        createdAt = $CreatedAt.ToUniversalTime().ToString('o')
        dueAt = $CreatedAt.ToUniversalTime().AddMinutes(30).ToString('o')
        nextAttemptAt = $CreatedAt.ToUniversalTime().AddMinutes(30).ToString('o')
        status = 'scheduled'; attempts = 0; steps = $steps; lines = @(); updatedAt = [datetime]::UtcNow.ToString('o')
    }
    Save-M365QueueJob $job
    return $job
}

function New-M365QueueJobForExistingUser {
    param([hashtable]$Data)
    $upn = [string]$Data.userPrincipalName
    if ([string]::IsNullOrWhiteSpace($upn)) { throw 'Informe o UPN da conta existente.' }
    if (-not $Data.licenses -and -not $Data.groups) { throw 'Selecione pelo menos uma licenca ou grupo.' }
    # Variable filter avoids interpolation of user input into the filter syntax.
    $users = @(Get-ADUser -Filter { UserPrincipalName -eq $upn } -Properties whenCreated, UserPrincipalName, Enabled -ErrorAction Stop)
    if ($users.Count -ne 1) { throw 'Nao foi encontrada uma unica conta com esse UPN no AD.' }
    $user = $users[0]
    if (-not $user.Enabled) { throw 'A conta esta desabilitada no AD.' }
    if (-not $user.whenCreated -or -not $user.ObjectGuid) { throw 'Nao foi possivel determinar a data de criacao ou o identificador da conta.' }
    $existing = @(Get-M365QueueJobs | Where-Object {
        $_.objectGuid -eq [string]$user.ObjectGuid -and $_.status -in @('scheduled', 'retry', 'waiting_auth', 'running', 'failed')
    })
    if ($existing.Count) { throw 'Essa conta ja possui um agendamento pendente. Consulte a fila.' }
    return New-M365QueueJob -Upn $user.UserPrincipalName -ObjectGuid ([string]$user.ObjectGuid) -Selection $Data -CreatedAt ([datetime]$user.whenCreated)
}

function Invoke-M365QueueTick {
    $now = [datetime]::UtcNow
    if (($now - $script:M365QueueLastPoll).TotalSeconds -lt 15) { return }
    $script:M365QueueLastPoll = $now
    # One due job per tick; HTTP requests are handled between jobs.
    $job = Get-M365QueueJobs | Where-Object {
        $_.status -in @('scheduled', 'retry', 'waiting_auth', 'running') -and
        ([datetime]$_.nextAttemptAt).ToUniversalTime() -le $now
    } | Sort-Object nextAttemptAt | Select-Object -First 1
    if (-not $job) { return }
    try {
        $pending = @($job.steps | Where-Object { -not $_.done })
        $connection = Get-M365Status
        if ((($pending | Where-Object source -eq 'Graph') -and -not $connection.graphConnected) -or
            (($pending | Where-Object source -eq 'Exchange') -and -not $connection.exchangeConnected)) {
            $job.status = 'waiting_auth'
            $job.lines = @('Aguardando reconexao ao Microsoft 365 no servidor.')
            $job.nextAttemptAt = $now.AddSeconds(30).ToString('o')
            Save-M365QueueJob $job
            return
        }
        # Bind to the original AD object, avoiding a deleted/recreated or disabled account.
        $adUser = Get-ADUser -Identity $job.objectGuid -Properties UserPrincipalName, Enabled -ErrorAction Stop
        if (-not $adUser.Enabled -or $adUser.UserPrincipalName -ne $job.userPrincipalName) {
            $job.status = 'failed'
            $job.lines = @('Conta desabilitada ou UPN alterado no AD. Revise antes de tentar novamente.')
            Save-M365QueueJob $job
            return
        }
        $job.status = 'running'
        $job.attempts++
        $job.lines = @()
        $job.nextAttemptAt = $now.AddMinutes(5).ToString('o')
        Save-M365QueueJob $job
        foreach ($step in $pending) {
            $data = @{ userPrincipalName = $job.userPrincipalName; licenses = @(); groups = @() }
            if ($step.kind -eq 'license') { $data.licenses = @($step.id) }
            else { $data.groups = @(@{ id = $step.id; name = $step.name; source = $step.source }) }
            $result = Invoke-AplicarM365 $data
            $job.lines = @($job.lines) + @($result.lines)
            if ($result.success) { $step.done = $true }
            $job.updatedAt = [datetime]::UtcNow.ToString('o')
            Save-M365QueueJob $job
        }
        if (-not @($job.steps | Where-Object { -not $_.done }).Count) { $job.status = 'completed' }
        elseif ($job.attempts -ge 36) { $job.status = 'failed' }
        else { $job.status = 'retry' }
        Save-M365QueueJob $job
        $script:M365LicensesCache.Timestamp = [datetime]::MinValue
        Write-Log "[M365 Queue] $($job.userPrincipalName): $($job.status)" 'Cyan'
    } catch {
        # A write failure must never be silently treated as a completed operation.
        Write-Log "[M365 Queue] $($job.userPrincipalName): $_" 'Red'
        $job.status = 'failed'
        $job.lines = @($job.lines) + @("Falha na fila: $($_.Exception.Message)")
        try { Save-M365QueueJob $job } catch { Write-Log "[M365 Queue] Persistence failure: $_" 'Red' }
    }
}
