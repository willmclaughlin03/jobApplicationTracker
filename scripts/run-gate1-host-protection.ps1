<# Defaults to an offline overview. Select -Batch 1..4; -Live needs separate approval. #>
param([switch]$Live, [ValidateSet('1', '2', '3', '4')][string]$Batch)
$ErrorActionPreference = 'Stop'

<#
Run the fixed Node diagnostic at Runner with one validated BatchId (0 is offline overview).
LiveMode requires BatchId 1..4 and appends --live; no invocation advances to another batch.
Drain both pipes asynchronously, terminate after 315 seconds, and suppress raw stderr.
Return captured stdout as Json and the process ExitCode; always dispose the process.
#>
function Invoke-Gate1HostNode([string]$Runner, [bool]$LiveMode, [int]$BatchId = 0) {
    if ($BatchId -lt 0 -or $BatchId -gt 4 -or ($LiveMode -and $BatchId -eq 0)) {
        throw 'Select exactly one batch from 1 through 4 for live execution.'
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node.exe'
    $startInfo.Arguments = '"' + $Runner + '"'
    if ($BatchId -gt 0) { $startInfo.Arguments += ' --batch ' + $BatchId }
    if ($LiveMode) { $startInfo.Arguments += ' --live' }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Diagnostic process did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(315000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'Diagnostic process exceeded its deadline.'
        }
        return @{ Json = $stdout.GetAwaiter().GetResult(); ExitCode = $process.ExitCode }
    } finally { $process.Dispose() }
}

<#
Prepare or run one BatchId and persist a bounded report under this checkout's .tmp directory.
Validate identity, selected scope, counters and completion before saving; reject cross-batch reports.
Create a unique overview/batch/mode timestamp/GUID filename with UTF-8 and CreateNew.
Return Path/ExitCode, preserve nonzero child exit codes, and force stopped reports to exit nonzero.
#>
function Invoke-Gate1HostProtection([switch]$LiveMode, [int]$BatchId = 0) {
    if ($BatchId -lt 0 -or $BatchId -gt 4 -or ($LiveMode -and $BatchId -eq 0)) {
        throw 'Select exactly one batch from 1 through 4 for live execution.'
    }
    $runner = Join-Path $PSScriptRoot 'gate1-host-protection.js'
    $result = Invoke-Gate1HostNode -Runner $runner -LiveMode ([bool]$LiveMode) -BatchId $BatchId
    if ([string]::IsNullOrWhiteSpace($result.Json) -or
        [Text.Encoding]::UTF8.GetByteCount($result.Json) -gt 65536) {
        throw 'Diagnostic did not produce a bounded report.'
    }
    try { $report = $result.Json | ConvertFrom-Json } catch { throw 'Diagnostic report was invalid.' }
    $expectedMode = 'prepare'
    $allowedResults = @('prepared', 'stopped')
    if ($LiveMode) { $expectedMode = 'live'; $allowedResults = @('completed', 'stopped') }
    $expectedRequests = 0
    $batchSizes = @(30, 30, 30, 12)
    if ($BatchId -gt 0) { $expectedRequests = $batchSizes[$BatchId - 1] }
    if ($report.schemaVersion -ne 2 -or $report.scope -ne 'selected_login_host_access_only' -or
        $report.mode -ne $expectedMode -or $report.gate1Status -ne 'open' -or
        $report.result -notin $allowedResults -or
        $report.inventoryId -ne 'gate1-host-delta-e50c5e9-9fe633d-20260923' -or
        $report.inventorySha256 -ne '716bde62775672217440fd52dc765fe712730128c64be985ae5da299d38d76bb' -or
        $report.target.deploymentId -ne 'dpl_2hjZCj2WZ251FZUJsTyaRiVoq1mH' -or
        $report.target.nextBuildId -ne 'q0zlIgmPLmJWCHTAV9jpK' -or
        $report.totalInventoryHosts -ne 102 -or $report.limits.maxRequests -ne $expectedRequests -or
        $report.outsideSelectedBatch -ne (102 - $expectedRequests) -or
        $report.inventory -isnot [Array] -or $report.inventory.Count -ne $expectedRequests -or
        $report.receipts -isnot [Array]) { throw 'Diagnostic report contract failed.' }
    if (($BatchId -eq 0 -and $null -ne $report.batch) -or
        ($BatchId -gt 0 -and $report.batch -ne $BatchId)) { throw 'Diagnostic batch did not match.' }
    foreach ($field in @('requests', 'responses', 'expectedPatterns', 'unvisited')) {
        $value = $report.$field
        if (($value -isnot [int] -and $value -isnot [long]) -or
            $value -lt 0 -or $value -gt $expectedRequests) {
            throw 'Diagnostic request accounting failed.'
        }
    }
    if (($report.requests + $report.unvisited) -ne $expectedRequests -or
        $report.responses -gt $report.requests -or $report.expectedPatterns -gt $report.responses -or
        $report.receipts.Count -gt $report.requests -or
        ($expectedMode -eq 'prepare' -and $report.requests -ne 0)) {
        throw 'Diagnostic request accounting failed.'
    }
    if ($report.result -eq 'completed' -and ($report.requests -ne $expectedRequests -or
        $report.expectedPatterns -ne $expectedRequests -or $report.receipts.Count -ne $expectedRequests -or
        $null -ne $report.failure)) { throw 'Diagnostic completion accounting failed.' }
    $suffix = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff') + '-' + [Guid]::NewGuid().ToString('N')
    $reportDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp'
    [void][IO.Directory]::CreateDirectory($reportDirectory)
    $label = 'overview'
    if ($BatchId -gt 0) { $label = 'batch-' + $BatchId }
    $path = Join-Path $reportDirectory ('gate1-host-protection-' + $label + '-' + $expectedMode + '-' + $suffix + '.json')
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        $bytes = $encoding.GetBytes($result.Json)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    $exitCode = $result.ExitCode
    if ($report.result -eq 'stopped' -and $exitCode -eq 0) { $exitCode = 1 }
    return @{ Path = $path; ExitCode = $exitCode }
}

# Dot-sourcing defines helpers for mocked tests without executing Node or any HTTP.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $selectedBatch = 0
        if ($Batch) { $selectedBatch = [int]$Batch }
        $saved = Invoke-Gate1HostProtection -LiveMode:$Live -BatchId $selectedBatch
        Write-Output ('Report: ' + $saved.Path)
        exit $saved.ExitCode
    } catch {
        Write-Error 'Host diagnostic failed; no live retry was attempted.' -ErrorAction Continue
        exit 1
    }
}
