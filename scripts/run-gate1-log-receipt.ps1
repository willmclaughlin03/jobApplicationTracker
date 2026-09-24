<#
Offline by default. -Template emits unapproved trial attestations; -ConfigTemplate
emits a read-only config profile; -ConfigCheck prepares that check without HTTP.
-ProfilePath reviews either profile. Separately approved -Live -Approval binds
the selected operation to reviewed code/profile. No credentials belong in arguments or files.
For a full trial, keep the WAF edit freeze until the report verifies restoration. If interrupted,
inspect .tmp/gate1-log-receipt-<approval>.json; do not rerun or bulk-restore config.
#>
[CmdletBinding()]
param([switch]$Template, [switch]$ConfigTemplate, [switch]$ConfigCheck,
    [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<#
Invoke a fixed Node mode with bounded stdin and hidden output capture. The
210-second child deadline includes stdin, 120 seconds of work, 60 seconds of
cleanup and reporting. Raw stderr is never emitted. On launcher interruption,
give the child its remaining deadline before killing it; hard termination can
still prevent rollback and requires operator recovery review.
#>
function Invoke-Gate1ReceiptNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--prepare', '--template', '--config-prepare', '--config-template', '--review', '--live') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 16384) { throw 'Invalid receipt input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-log-receipt.js'
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node.exe'
    $startInfo.Arguments = '"' + $runner + '" ' + $Mode
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $childMs = if ($Mode -ceq '--live') { 210000 } else { 30000 }
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Receipt process did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputJson) {
            $write = $process.StandardInput.WriteAsync($InputJson)
            if (-not $write.Wait(5000)) { throw 'Receipt input deadline exceeded.' }
        }
        $process.StandardInput.Close()
        while (-not $process.HasExited) {
            $remaining = [Math]::Max(0, $childMs - $timer.ElapsedMilliseconds)
            if ($remaining -eq 0) { throw 'Receipt process deadline exceeded; inspect recovery record.' }
            $null = $process.WaitForExit([int][Math]::Min(1000, $remaining))
        }
        $json = $stdout.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192 -or
            [string]::IsNullOrWhiteSpace($json)) { throw 'No bounded sanitized receipt report.' }
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        if ($started -and -not $process.HasExited) {
            # Preserve the full owned cleanup reserve even if the launcher is cancelled.
            while (-not $process.HasExited -and $timer.ElapsedMilliseconds -lt $childMs) {
                $null = $process.WaitForExit(1000)
            }
            if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
        }
        $InputJson = $null
        $process.Dispose()
    }
}

<#
Read only the provider token without echo/history; ConfigurationOnly selects
the read-only prompt. Release the BSTR; the string reaches only child stdin.
#>
function Read-Gate1ReceiptToken([switch]$ConfigurationOnly) {
    $prompt = if ($ConfigurationOnly) { 'Vercel API token for the approved read-only config GET (hidden)' }
        else { 'Vercel API token for the separately approved WAF trial (hidden)' }
    $secure = Read-Host -Prompt $prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}

<#
Reject changed target, operation or budgets before prompting for a credential.
Node independently binds the complete profile and executable files to approval.
#>
function Test-Gate1ReceiptReview($Prepared, $ReceiptProfile) {
    if ($Prepared.schemaVersion -ne 1 -or $Prepared.mode -cne 'prepare' -or
        $Prepared.liveApproved -isnot [bool] -or $Prepared.liveApproved -ne $false -or
        $Prepared.appRequests -ne 0 -or $Prepared.providerRequests -ne 0 -or
        $Prepared.gate1Status -cne 'open' -or $Prepared.sourceAgreement -cne 'not_evaluated' -or
        $Prepared.providerOrigin -cne 'https://api.vercel.com' -or
        $ReceiptProfile.schemaVersion -ne 1 -or $Prepared.profile.schemaVersion -ne 1) { return $false }
    $target = @{ projectId = 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom'; teamId = 'team_7o3efmwjZbMc2Bfy9qAzkc9q';
        hostname = 'job-application-tracker-kappa-seven.vercel.app' }
    foreach ($key in $target.Keys) {
        if ($Prepared.target.$key -cne $target[$key] -or $ReceiptProfile.$key -cne $target[$key] -or
            $Prepared.profile.$key -cne $target[$key]) { return $false }
    }
    if ($Prepared.profile.reviewedAt -cne $ReceiptProfile.reviewedAt) { return $false }
    $configOnly = $ReceiptProfile.queryMode -ceq 'config_check'
    if ($configOnly) {
        if ($Prepared.scope -cne 'provider_firewall_config_check_only' -or
            $Prepared.queryMode -cne 'config_check' -or $Prepared.profile.queryMode -cne 'config_check' -or
            $Prepared.endpoint -cne 'https://api.vercel.com/v1/security/firewall/config' -or
            $Prepared.method -cne 'GET' -or
            $Prepared.PSObject.Properties.Name -cnotcontains 'application' -or $null -ne $Prepared.application -or
            $Prepared.PSObject.Properties.Name -cnotcontains 'rule' -or $null -ne $Prepared.rule -or
            @($Prepared.queryParameters.PSObject.Properties).Count -ne 2 -or
            $Prepared.queryParameters.PSObject.Properties.Name -cnotcontains 'projectId' -or
            $Prepared.queryParameters.PSObject.Properties.Name -cnotcontains 'teamId' -or
            $Prepared.queryParameters.projectId -cne $target.projectId -or
            $Prepared.queryParameters.teamId -cne $target.teamId) { return $false }
        foreach ($counter in @('appRequests', 'providerRequests', 'eventsQueries', 'configMutations')) {
            $actual = $Prepared.$counter
            if (($actual -isnot [int] -and $actual -isnot [long]) -or $actual -ne 0) { return $false }
        }
        $attestations = @('sourceCodeReviewed', 'credentialLoggingReviewed', 'includedUsageHeadroom')
        $limits = @{ maxAppRequests = 0; maxProviderRequests = 1; maxEventsQueries = 0; maxConfigMutations = 0;
            concurrency = 1; requestMs = 10000; overallMs = 15000; providerBytes = 262144;
            headerBytes = 16384; inputBytes = 16384; reportBytes = 8192; profileAgeMs = 900000 }
    } else {
        if ($ReceiptProfile.PSObject.Properties.Name -contains 'queryMode' -or
            $Prepared.profile.PSObject.Properties.Name -contains 'queryMode' -or
            $Prepared.PSObject.Properties.Name -contains 'queryMode' -or
            $Prepared.scope -cne 'ordinary_log_receipt_trial_only' -or
            $Prepared.application.method -cne 'GET' -or $Prepared.application.path -cne '/api/auth/session' -or
            $Prepared.application.credentials -cne 'none' -or $Prepared.rule.action -cne 'log' -or
            $Prepared.rule.rateLimit -isnot [bool] -or $Prepared.rule.rateLimit -ne $false) { return $false }
        $attestations = @('sourceCodeReviewed', 'credentialLoggingReviewed', 'noConcurrentWafEdits',
            'includedUsageHeadroom', 'recoveryProcedureReviewed')
        $limits = @{ maxAppRequests = 1; maxProviderRequests = 11; mainProviderRequests = 6; cleanupProviderRequests = 5;
            maxEventsQueries = 1; concurrency = 1; requestMs = 10000; mainMs = 120000; cleanupMs = 60000;
            overallMs = 180000; settlementMs = 30000; providerBytes = 262144; appBytes = 16384;
            headerBytes = 16384; inputBytes = 16384; reportBytes = 8192; profileAgeMs = 900000 }
    }
    if (@($ReceiptProfile.attestations.PSObject.Properties).Count -ne $attestations.Count -or
        @($Prepared.profile.attestations.PSObject.Properties).Count -ne $attestations.Count) { return $false }
    foreach ($key in $attestations) {
        if ($ReceiptProfile.attestations.$key -isnot [bool] -or $ReceiptProfile.attestations.$key -ne $true -or
            $Prepared.profile.attestations.$key -isnot [bool] -or $Prepared.profile.attestations.$key -ne $true) { return $false }
    }
    if (@($Prepared.limits.PSObject.Properties).Count -ne $limits.Count) { return $false }
    foreach ($key in $limits.Keys) {
        $actual = $Prepared.limits.$key
        if (($actual -isnot [int] -and $actual -isnot [long]) -or $actual -ne $limits[$key]) { return $false }
    }
    return $true
}

<#
Review before any credential entry. The explicit terminal confirmation refers
to an already separately approved live trial, never grants billing/other edits.
An approval is consumed by the runner before its first provider request.
#>
function Invoke-Gate1LogReceipt {
    if ($args.Count -ne 0 -or ($Template -and ($ConfigTemplate -or $ConfigCheck -or $ProfilePath -or $Live -or $Approval)) -or
        ($ConfigTemplate -and ($ConfigCheck -or $ProfilePath -or $Live -or $Approval)) -or
        ($ConfigCheck -and ($ProfilePath -or $Live -or $Approval)) -or
        ($Live -and (-not $ProfilePath -or $Approval -cnotmatch '^[a-f0-9]{64}$')) -or
        (-not $Live -and $Approval)) { throw 'Invalid receipt mode.' }
    if ($Template) { return Invoke-Gate1ReceiptNode -Mode '--template' }
    if ($ConfigTemplate) { return Invoke-Gate1ReceiptNode -Mode '--config-template' }
    if ($ConfigCheck) { return Invoke-Gate1ReceiptNode -Mode '--config-prepare' }
    if (-not $ProfilePath) { return Invoke-Gate1ReceiptNode -Mode '--prepare' }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Extension -ine '.json' -or $file.Length -gt 8192 -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a bounded local JSON profile.' }
    try { $receiptProfile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json }
    catch { throw 'Invalid receipt JSON profile.' }
    $profileJson = ConvertTo-Json -InputObject $receiptProfile -Depth 8 -Compress
    $review = Invoke-Gate1ReceiptNode -Mode '--review' -InputJson $profileJson
    if ($review.ExitCode -ne 0) { throw 'Receipt profile review failed.' }
    if (-not $Live) { return $review }
    $prepared = $review.Json | ConvertFrom-Json
    if ($prepared.approvalId -cne $Approval -or -not (Test-Gate1ReceiptReview -Prepared $prepared -ReceiptProfile $receiptProfile)) {
        throw 'Approval must match the exact reviewed receipt profile and runner.'
    }
    Write-Host $review.Json
    $configOnly = $receiptProfile.queryMode -ceq 'config_check'
    if ($configOnly) {
        Write-Host 'This read-only check makes ONE configuration GET, ZERO application requests, and ZERO WAF changes.'
        $confirmation = Read-Host -Prompt 'Approve ONE configuration GET, ZERO app requests and ZERO WAF changes. Type RUN CONFIG CHECK ONCE'
        if ($confirmation -cne 'RUN CONFIG CHECK ONCE') { throw 'Config-check live confirmation was not provided.' }
    } else {
        Write-Host 'This trial modifies WAF configuration. Keep all other WAF edits frozen until restoration is verified.'
        $confirmation = Read-Host -Prompt 'Separately approved: ONE app request, at most ELEVEN provider attempts, including cleanup. Type RUN LOG RECEIPT ONCE'
        if ($confirmation -cne 'RUN LOG RECEIPT ONCE') { throw 'Receipt live confirmation was not provided.' }
    }
    $token = $null
    $envelope = $null
    try {
        $token = if ($configOnly) { Read-Gate1ReceiptToken -ConfigurationOnly } else { Read-Gate1ReceiptToken }
        if ($token -cnotmatch '^[A-Za-z0-9_-]{20,512}$') { throw 'Receipt credential contract failed.' }
        $envelope = ConvertTo-Json -Depth 8 -Compress -InputObject @{
            profile = $receiptProfile; approval = $Approval; credentials = @{ providerToken = $token }
        }
        return Invoke-Gate1ReceiptNode -Mode '--live' -InputJson $envelope
    } finally { $token = $null; $envelope = $null }
}

# Dot-sourcing defines functions for offline mocked launcher tests only.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1LogReceipt
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) {
            $stoppedReport = $result.Json | ConvertFrom-Json
            if ($stoppedReport.scope -ceq 'provider_firewall_config_check_only') {
                Write-Warning 'Configuration check stopped. Share the sanitized validation report; do not rerun automatically.'
            } else {
                Write-Warning 'Trial stopped. Inspect cleanup status/recovery record; do not rerun automatically.'
            }
        }
        exit $result.ExitCode
    } catch {
        Write-Error 'Diagnostic preparation/execution failed. Do not rerun automatically. For a WAF trial, inspect the recovery record before further WAF edits.' -ErrorAction Continue
        exit 1
    }
}
