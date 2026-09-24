<#
Offline by default: -Template creates a metrics profile; -EventsTemplate creates
an Events profile. -ProfilePath reviews either. Separately approved -Live -Approval permits one provider query, zero app
requests. Enter only the Vercel API token, through the hidden prompt.
#>
[CmdletBinding()]
param([switch]$Template, [switch]$EventsTemplate, [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<#
Run a fixed Node mode with bounded stdin. Drain stdout/stderr concurrently but
never print raw stderr. The 45-second child deadline includes input delivery;
the runner separately bounds its single HTTP request and execution time.
#>
function Invoke-Gate1AccessNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -notin @('--prepare', '--template', '--events-template', '--review', '--live') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 16384) { throw 'Invalid diagnostic input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-provider-access.js'
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
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Diagnostic process did not start.' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputJson) {
            $write = $process.StandardInput.WriteAsync($InputJson)
            if (-not $write.Wait(5000)) { throw 'Diagnostic input exceeded its deadline.' }
        }
        $process.StandardInput.Close()
        $remaining = [Math]::Max(0, 45000 - $timer.ElapsedMilliseconds)
        if (-not $process.WaitForExit([int]$remaining)) { throw 'Diagnostic process exceeded its deadline.' }
        $json = $stdout.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384 -or
            [string]::IsNullOrWhiteSpace($json)) { throw 'Diagnostic produced no bounded sanitized report.' }
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill()
            $null = $process.WaitForExit(5000)
        }
        $InputJson = $null
        $process.Dispose()
    }
}

<#
Prompt without terminal echo/history; release the temporary native BSTR. Managed
token strings remain transient in memory and are never written by this launcher.
#>
function Read-Gate1AccessToken {
    $secure = Read-Host -Prompt 'Vercel API token for the approved team query (hidden)' -AsSecureString
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
Check the reviewed operation against the selected profile before secret entry.
Only the two metrics modes or the exact Events GET and fixed limits are accepted;
Events has no server row limit. This helper performs no network or file writes.
#>
function Test-Gate1AccessReview($Prepared, $Profile) {
    if ($Profile.queryMode -cnotin @('discovery_shape', 'action_control', 'events_access') -or
        $Prepared.queryMode -cne $Profile.queryMode -or $Prepared.schemaVersion -ne 2 -or
        $Prepared.profile.queryMode -cne $Profile.queryMode -or $Prepared.mode -cne 'prepare' -or
        $Prepared.liveApproved -isnot [bool] -or $Prepared.liveApproved -ne $false -or
        $Prepared.appRequests -ne 0 -or $Prepared.providerRequests -ne 0) { return $false }
    $events = $Profile.queryMode -ceq 'events_access'
    $expectedScope = if ($events) { 'provider_firewall_events_access_only' } else { 'provider_metrics_access_only' }
    $expectedEndpoint = if ($events) { 'https://api.vercel.com/v1/security/firewall/events' } else { 'https://api.vercel.com/metrics/v1' }
    $expectedMethod = if ($events) { 'GET' } else { 'POST' }
    if ($Prepared.scope -cne $expectedScope -or $Prepared.endpoint -cne $expectedEndpoint -or
        $Prepared.method -cne $expectedMethod) { return $false }
    $expectedLimits = @{ maxAppRequests = 0; maxProviderRequests = 1; maxWafQueries = 1;
        concurrency = 1; requestMs = 10000; overallMs = 15000; providerBytes = 262144;
        headerBytes = 16384; inputBytes = 16384; reportBytes = 8192; queryWindowMs = 60000;
        profileAgeMs = 900000 }
    if (@($Prepared.limits.PSObject.Properties).Count -ne ($expectedLimits.Count + 1)) { return $false }
    foreach ($key in $expectedLimits.Keys) {
        $actual = $Prepared.limits.$key
        if (($actual -isnot [int] -and $actual -isnot [long]) -or $actual -ne $expectedLimits[$key]) { return $false }
    }
    if ($null -eq $Prepared.limits.PSObject.Properties['rowLimit']) { return $false }
    if ($events) {
        if ($null -ne $Prepared.limits.rowLimit -or $null -ne $Prepared.query -or
            $Prepared.logActionCoverage -cne 'not_evaluated') { return $false }
        $expectedParameters = @{ projectId = $Profile.projectId; teamId = $Profile.teamId; hosts = $Profile.hostname;
            startTimestamp = [DateTimeOffset]::Parse($Profile.queryWindow.start, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds();
            endTimestamp = [DateTimeOffset]::Parse($Profile.queryWindow.end, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() }
        if (@($Prepared.queryParameters.PSObject.Properties).Count -ne $expectedParameters.Count) { return $false }
        foreach ($key in $expectedParameters.Keys) {
            if ($Prepared.queryParameters.$key -cne $expectedParameters[$key]) { return $false }
        }
    } elseif ($Prepared.limits.rowLimit -ne 2) { return $false }
    return $true
}

<#
Validate/review the local profile before prompting. Live approval must match the
exact current runner/profile; Node checks again. No deployment/probe credential
is requested. Only the runner's sanitized report is returned and saved locally.
#>
function Invoke-Gate1ProviderAccess {
    if ($args.Count -ne 0 -or ($Template -and ($EventsTemplate -or $ProfilePath -or $Live -or $Approval)) -or
        ($EventsTemplate -and ($ProfilePath -or $Live -or $Approval)) -or
        ($Live -and (-not $ProfilePath -or $Approval -cnotmatch '^[a-f0-9]{64}$')) -or
        (-not $Live -and $Approval)) { throw 'Invalid provider diagnostic mode.' }
    if ($Template) { return Invoke-Gate1AccessNode -Mode '--template' }
    if ($EventsTemplate) { return Invoke-Gate1AccessNode -Mode '--events-template' }
    if (-not $ProfilePath) { return Invoke-Gate1AccessNode -Mode '--prepare' }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Extension -ine '.json' -or $file.Length -gt 8192 -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a bounded local JSON profile.' }
    try { $profile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json }
    catch { throw 'Invalid local JSON profile.' }
    $profileJson = ConvertTo-Json -InputObject $profile -Depth 8 -Compress
    $review = Invoke-Gate1AccessNode -Mode '--review' -InputJson $profileJson
    if ($review.ExitCode -ne 0) { throw 'Profile review failed.' }
    if (-not $Live) { return $review }
    $prepared = $review.Json | ConvertFrom-Json
    if ($prepared.approvalId -cne $Approval -or -not (Test-Gate1AccessReview -Prepared $prepared -Profile $profile)) {
        throw 'Approval must match the reviewed profile and runner.'
    }
    $token = $null
    $envelope = $null
    try {
        $token = Read-Gate1AccessToken
        if ($token -cnotmatch '^[A-Za-z0-9_-]{20,512}$') { throw 'Diagnostic credential contract failed.' }
        $envelope = ConvertTo-Json -Depth 8 -Compress -InputObject @{
            profile = $profile; approval = $Approval; credentials = @{ providerToken = $token }
        }
        return Invoke-Gate1AccessNode -Mode '--live' -InputJson $envelope
    } finally { $token = $null; $envelope = $null }
}

# Dot-sourcing defines functions for offline mocked launcher tests only.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1ProviderAccess
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) { Write-Warning 'Diagnostic stopped. Share only the sanitized report; do not rerun automatically.' }
        exit $result.ExitCode
    } catch {
        Write-Error 'Provider access preparation/execution failed. No automatic retry was attempted.' -ErrorAction Continue
        exit 1
    }
}
