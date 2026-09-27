<#
Offline by default: -Template emits unapproved facts; -ProfilePath reviews them.
Separately approved -Live -Approval permits one historical provider POST only.
This standalone reader never deploys code or reads saved authentication files.
#>
[CmdletBinding()]
param([switch]$Template, [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<#
Run one fixed Node mode with bounded stdin and a 90-second child deadline.
Credentials stay off argv; the runner owns its 45-second HTTP/60-second run limits.
Raw child stderr is drained but never displayed.
#>
function Invoke-Gate1TrafficNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--prepare', '--template', '--review', '--live') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 16384) { throw 'Invalid traffic diagnostic input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-traffic-receipt.js'
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
        if (-not $started) { throw 'Traffic diagnostic process did not start.' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputJson) {
            $write = $process.StandardInput.WriteAsync($InputJson)
            if (-not $write.Wait(5000)) { throw 'Traffic diagnostic input deadline.' }
        }
        $process.StandardInput.Close()
        $remaining = [Math]::Max(0, 90000 - $timer.ElapsedMilliseconds)
        if (-not $process.WaitForExit([int]$remaining)) { throw 'Traffic diagnostic child deadline.' }
        $json = $stdout.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384 -or
            [string]::IsNullOrWhiteSpace($json)) { throw 'No bounded sanitized report.' }
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
        $InputJson = $null
        $process.Dispose()
    }
}

<# Compare JSON objects recursively with exact keys/types and array order; reject added scope fields. #>
function Test-Gate1TrafficEqual($Actual, $Expected) {
    if ($null -eq $Expected) { return $null -eq $Actual }
    if ($null -eq $Actual) { return $false }
    if ($Expected -is [string]) { return $Actual -is [string] -and $Actual -ceq $Expected }
    if ($Expected -is [bool]) { return $Actual -is [bool] -and $Actual -eq $Expected }
    if ($Expected -is [int] -or $Expected -is [long]) {
        return ($Actual -is [int] -or $Actual -is [long]) -and $Actual -eq $Expected
    }
    if ($Expected -is [array]) {
        if ($Actual -isnot [array] -or $Actual.Count -ne $Expected.Count) { return $false }
        for ($index = 0; $index -lt $Expected.Count; $index++) {
            if (-not (Test-Gate1TrafficEqual $Actual[$index] $Expected[$index])) { return $false }
        }
        return $true
    }
    if ($Expected -isnot [System.Collections.IDictionary] -or $Actual -isnot [pscustomobject]) { return $false }
    $keys = @($Actual.PSObject.Properties.Name)
    if ($keys.Count -ne $Expected.Count) { return $false }
    foreach ($key in $Expected.Keys) {
        if ($keys -cnotcontains $key -or -not (Test-Gate1TrafficEqual $Actual.$key $Expected[$key])) { return $false }
    }
    return $true
}

<# Independently pin the whole query/limits/source/profile before confirmation or secret entry; no HTTP. #>
function Test-Gate1TrafficReview($Prepared, $Profile) {
    $project = 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom'
    $team = 'team_7o3efmwjZbMc2Bfy9qAzkc9q'
    $hostname = 'job-application-tracker-kappa-seven.vercel.app'
    $scope = 'historical_firewall_traffic_summary_only'
    $digest = '4403d08daef40c4aeed403a221f3c1948c505404c5bee8677c474eab34fa5581'
    $rule = 'rule_gate1_log_receipt_3a4ee48060b1b2562857b38077e4a799_VcUuC5'
    $source = @{ sha256 = $digest; trialId = '3a4ee48060b1b2562857b38077e4a799'; ruleId = $rule;
        queryWindow = @{ start = '2026-09-27T16:42:07.926Z'; end = '2026-09-27T16:42:39.357Z' } }
    $target = @{ projectId = $project; teamId = $team; hostname = $hostname }
    $limits = @{ maxAppRequests = 0; maxProviderRequests = 1; maxTrafficQueries = 1;
        maxConfigReads = 0; maxConfigMutations = 0; concurrency = 1; requestMs = 45000; overallMs = 60000;
        providerBytes = 262144; headerBytes = 16384; inputBytes = 16384; reportBytes = 8192;
        profileAgeMs = 900000; retentionMs = 86400000; rowLimit = 2 }
    $query = @{ scope = @{ type = 'project'; ownerId = $team; projectIds = @($project) };
        metric = 'vercel.firewall_action.count'; aggregation = 'sum'; startTime = $source.queryWindow.start;
        endTime = $source.queryWindow.end; granularity = @{ hours = 1 };
        groupBy = @('waf_rule_id', 'waf_action', 'request_hostname', 'request_path');
        filter = "(waf_rule_id eq '$rule') and (request_hostname eq '$hostname') and (request_path eq '/api/auth/session') and (waf_action eq 'log')";
        limit = 2; orderBy = 'vercel_firewall_action_count_sum'; orderDirection = 'desc' }
    $expectedProfile = @{ schemaVersion = 1; scope = $scope; projectId = $project; teamId = $team; hostname = $hostname;
        sourceEvidence = $source; reviewedAt = $Profile.reviewedAt;
        attestations = @{ sourceCodeReviewed = $true; credentialLoggingReviewed = $true; includedUsageHeadroom = $true } }
    if ($Profile.reviewedAt -isnot [string] -or
        -not (Test-Gate1TrafficEqual $Profile $expectedProfile) -or
        -not (Test-Gate1TrafficEqual $Prepared.profile $expectedProfile) -or
        -not (Test-Gate1TrafficEqual $Prepared.target $target) -or
        -not (Test-Gate1TrafficEqual $Prepared.sourceEvidence $source) -or
        -not (Test-Gate1TrafficEqual $Prepared.limits $limits) -or
        -not (Test-Gate1TrafficEqual $Prepared.query $query)) { return $false }
    return $Prepared.schemaVersion -eq 1 -and $Prepared.mode -ceq 'prepare' -and $Prepared.scope -ceq $scope -and
        $Prepared.liveApproved -is [bool] -and $Prepared.liveApproved -eq $false -and
        $Prepared.endpoint -ceq "https://api.vercel.com/v2/observability/query?teamId=$team" -and
        $Prepared.method -ceq 'POST' -and $Prepared.reservationName -ceq "gate1-traffic-receipt-$digest.json" -and
        $Prepared.appRequests -eq 0 -and $Prepared.providerRequests -eq 0 -and $Prepared.configReads -eq 0 -and
        $Prepared.configMutations -eq 0 -and $Prepared.gate1Status -ceq 'open' -and
        $Prepared.sourceAgreement -ceq 'not_evaluated' -and $Prepared.correlation -ceq 'unqualified' -and
        $Prepared.completeness -ceq 'unqualified' -and $Prepared.nextStep -ceq 'obtain_separate_live_approval'
}

<# Prompt without echo/history; free the temporary BSTR and retain no saved credential. #>
function Read-Gate1TrafficToken {
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

<# Review a bounded credential-free JSON profile, check reservation, then confirm this one operation. #>
function Invoke-Gate1TrafficReceipt {
    if ($args.Count -ne 0 -or ($Template -and ($ProfilePath -or $Live -or $Approval)) -or
        ($Live -and (-not $ProfilePath -or $Approval -cnotmatch '^[a-f0-9]{64}$')) -or
        (-not $Live -and $Approval)) { throw 'Invalid traffic diagnostic mode.' }
    if ($Template) { return Invoke-Gate1TrafficNode '--template' }
    if (-not $ProfilePath) { return Invoke-Gate1TrafficNode '--prepare' }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Extension -ine '.json' -or $file.Length -gt 8192 -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a bounded local JSON profile.' }
    try { $profile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json }
    catch { throw 'Invalid local JSON profile.' }
    $review = Invoke-Gate1TrafficNode '--review' (ConvertTo-Json -InputObject $profile -Depth 10 -Compress)
    if ($review.ExitCode -ne 0) { throw 'Traffic profile review failed.' }
    if (-not $Live) { return $review }
    $prepared = $review.Json | ConvertFrom-Json
    if ($prepared.approvalId -cne $Approval -or -not (Test-Gate1TrafficReview $prepared $profile)) {
        throw 'Approval must match the exact reviewed traffic query and runner.'
    }
    $reservation = Join-Path (Join-Path $PSScriptRoot '../.tmp') $prepared.reservationName
    if (Test-Path -LiteralPath $reservation) { throw 'Traffic query already reserved. Preserve its report; do not replay.' }
    if ((Read-Host 'Type RUN TRAFFIC RECEIPT ONCE for this separately approved provider query') -cne 'RUN TRAFFIC RECEIPT ONCE') {
        throw 'Traffic query was not confirmed.'
    }
    $token = $null; $envelope = $null
    try {
        $token = Read-Gate1TrafficToken
        if ($token -cnotmatch '^[A-Za-z0-9_-]{20,512}$') { throw 'Traffic credential contract failed.' }
        $envelope = ConvertTo-Json -Depth 10 -Compress -InputObject @{
            profile = $profile; approval = $Approval; credentials = @{ providerToken = $token }
        }
        return Invoke-Gate1TrafficNode '--live' $envelope
    } finally { $token = $null; $envelope = $null }
}

# Dot-sourcing provides offline test seams without executing the launcher.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1TrafficReceipt
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) { Write-Warning 'Diagnostic stopped. Share only its sanitized report; do not rerun automatically.' }
        exit $result.ExitCode
    } catch {
        [Console]::Error.WriteLine('Traffic diagnostic preparation/execution failed. No automatic retry was attempted.')
        exit 1
    }
}
