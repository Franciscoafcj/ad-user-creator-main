# Offline behavioral checks. No AD, Graph or Exchange connections are made.
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'M365Queue.ps1')
$script:M365QueueDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('m365-queue-test-' + [guid]::NewGuid().ToString('N'))
$script:M365LicensesCache = @{ Timestamp = [datetime]::Now }
$script:Connected = $true
$script:Enabled = $true
$script:FailGroup = $true
$script:Calls = [System.Collections.Generic.List[string]]::new()
function Write-Log { param($Message, $Color) }
function Get-M365Status { @{ graphConnected = $script:Connected; exchangeConnected = $script:Connected } }
function Get-ADUser { param($Identity, $Properties, $ErrorAction) @{ Enabled = $script:Enabled; UserPrincipalName = 'test@example.invalid' } }
function Invoke-AplicarM365 {
    param($Data)
    if ($Data.licenses.Count) { $script:Calls.Add('license'); return @{ success = $true; lines = @('license OK') } }
    $script:Calls.Add('group')
    return @{ success = (-not $script:FailGroup); lines = @('group result') }
}
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Tick { $script:M365QueueLastPoll = [datetime]::MinValue; Invoke-M365QueueTick }
function Make-Due {
    $job = @(Get-M365QueueJobs)[0]
    $job.nextAttemptAt = [datetime]::UtcNow.AddSeconds(-1).ToString('o')
    Save-M365QueueJob $job
}
try {
    $created = [datetime]::UtcNow
    $job = New-M365QueueJob -Upn 'test@example.invalid' -ObjectGuid ([guid]::NewGuid().ToString()) -CreatedAt $created -Selection @{
        licenses = @('test-sku'); groups = @(@{ id = 'group'; name = 'Group'; source = 'Exchange' })
    }
    Assert-True ((([datetime]$job.dueAt).ToUniversalTime() - $created).TotalMinutes -eq 30) 'Must schedule exactly 30 minutes after creation.'
    Tick
    Assert-True ($script:Calls.Count -eq 0) 'Must not execute before due time.'
    $script:Connected = $false
    Make-Due
    Tick
    $job = @(Get-M365QueueJobs)[0]
    Assert-True ($job.status -eq 'waiting_auth' -and $job.attempts -eq 0) 'Disconnected queue must wait without consuming attempts.'
    $script:Connected = $true
    Make-Due
    Tick
    $job = @(Get-M365QueueJobs)[0]
    Assert-True ($job.status -eq 'retry' -and $job.steps[0].done -and -not $job.steps[1].done) 'Partial success must persist per step.'
    Assert-True ((([datetime]$job.nextAttemptAt).ToUniversalTime() - [datetime]::UtcNow).TotalMinutes -gt 4) 'Retry must wait five minutes.'
    # Reload the module to model a server restart (data stays on disk).
    $testDirectory = $script:M365QueueDirectory
    . (Join-Path (Split-Path $PSScriptRoot -Parent) 'M365Queue.ps1')
    $script:M365QueueDirectory = $testDirectory
    $script:FailGroup = $false
    Make-Due
    Tick
    $job = @(Get-M365QueueJobs)[0]
    Assert-True ($job.status -eq 'completed') 'Restart must recover and complete the pending step.'
    Assert-True (@($script:Calls | Where-Object { $_ -eq 'license' }).Count -eq 1) 'Completed license must not be repeated.'
    $count = $script:Calls.Count
    Tick
    Assert-True ($script:Calls.Count -eq $count) 'Completed job must not run again.'
    $job.status = 'retry'; $job.steps[1].done = $false; $job.attempts = 35
    Save-M365QueueJob $job
    $script:FailGroup = $true
    Make-Due
    Tick
    $job = @(Get-M365QueueJobs)[0]
    Assert-True ($job.status -eq 'failed' -and $job.attempts -eq 36) 'Retries must stop after 36 attempts.'
    $job.status = 'retry'; $job.attempts = 0
    Save-M365QueueJob $job
    $script:Enabled = $false
    Make-Due
    $count = $script:Calls.Count
    Tick
    Assert-True ($script:Calls.Count -eq $count -and (@(Get-M365QueueJobs)[0]).status -eq 'failed') 'Disabled account must not receive provisioning.'
    $job = @(Get-M365QueueJobs)[0]; $job.status = 'cancelled'; Save-M365QueueJob $job
    Make-Due
    Tick
    Assert-True ($script:Calls.Count -eq $count) 'Cancelled job must not execute.'
    # Recover an existing account without creating it again or changing its clock.
    $script:ExistingGuid = [guid]::NewGuid()
    $script:ExistingCreatedAt = [datetime]::UtcNow.AddMinutes(-10)
    function Get-ADUser { param($Filter, $Properties, $ErrorAction)
        return @{ Enabled = $true; UserPrincipalName = 'existing@example.invalid'; ObjectGuid = $script:ExistingGuid; whenCreated = $script:ExistingCreatedAt }
    }
    $existingJob = New-M365QueueJobForExistingUser @{ userPrincipalName = 'existing@example.invalid'; licenses = @('sku'); groups = @() }
    Assert-True ((([datetime]$existingJob.dueAt).ToUniversalTime() - $script:ExistingCreatedAt).TotalMinutes -eq 30) 'Recovery must use the original AD creation time.'
    $duplicateBlocked = $false
    try { New-M365QueueJobForExistingUser @{ userPrincipalName = 'existing@example.invalid'; licenses = @('sku') } }
    catch { $duplicateBlocked = $true }
    Assert-True $duplicateBlocked 'Recovery must reject a duplicate pending job.'
    # Extract only the creation function; never execute the real server startup.
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path (Split-Path $PSScriptRoot -Parent) 'Server.ps1'), [ref]$null, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) 'Server syntax must be valid.'
    $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-CriarUsuario' }, $true)
    . ([scriptblock]::Create($functionAst.Extent.Text))
    $ADModuleLoaded = $true
    $Cfg = @{ ouPadrao = 'OU=Test,DC=example,DC=invalid' }
    function Get-ADUser { param($Filter, $ErrorAction) return $null }
    function Normalizar-CPF { param($CPF) return $CPF }
    function Validar-CPF { param($CPF) return $true }
    function ConvertTo-SafeHashtable { param($Obj) return $Obj }
    $script:CreateFails = $false
    function New-ADUser {
        if ($script:CreateFails) { throw 'Simulated AD failure' }
        return @{ ObjectGuid = [guid]::NewGuid() }
    }
    $payload = @{ sam = 'test'; email = 'test@example.invalid'; senha = 'test-only-secret'; nome = 'Test'; cpf = '00000000000'; m365 = @{ licenses = @('sku'); groups = @() } }
    $createdResult = Invoke-CriarUsuario $payload
    Assert-True ($createdResult.success -and $createdResult.m365Job) 'Successful AD creation must persist a schedule.'
    $json = Get-Content -LiteralPath (Join-Path $script:M365QueueDirectory "$($createdResult.m365Job.id).json") -Raw
    Assert-True (-not $json.Contains('test-only-secret')) 'Queue must not store passwords.'
    $jobsBefore = @(Get-M365QueueJobs).Count
    $script:CreateFails = $true
    $failedResult = Invoke-CriarUsuario $payload
    Assert-True (-not $failedResult.success -and @(Get-M365QueueJobs).Count -eq $jobsBefore) 'AD failure must not schedule cloud changes.'
    $script:CreateFails = $false
    function Save-M365QueueJob { param($Job) throw 'Simulated disk error' }
    $diskResult = Invoke-CriarUsuario $payload
    Assert-True ($diskResult.success -and $diskResult.m365ScheduleError -and -not $diskResult.m365Job) 'Scheduling failure must preserve AD success and expose the error.'
    Write-Output 'PASS: delay, auth wait, partial success, restart, retry interval/limit, disabled account, cancellation, AD creation/failure, disk failure, no stored password, existing-account recovery and duplicate protection.'
} finally {
    # Only delete individual test files in the freshly allocated temp directory.
    if (Test-Path $script:M365QueueDirectory) {
        Get-ChildItem -LiteralPath $script:M365QueueDirectory -File | Remove-Item -Force
        Remove-Item -LiteralPath $script:M365QueueDirectory
    }
}
