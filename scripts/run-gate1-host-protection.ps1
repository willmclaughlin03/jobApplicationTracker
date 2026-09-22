<# Defaults to offline preparation. -Live requires separately granted operator approval. #>
param([switch]$Live)
$ErrorActionPreference = 'Stop'

<# Run the fixed Node file, drain both pipes, and return only captured stdout and the exit code. #>
function Invoke-Gate1HostNode([string]$Runner, [bool]$LiveMode) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node.exe'
    $startInfo.Arguments = '"' + $Runner + '"'
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

<# Save a valid runner report to a unique local file; never overwrite a previous observation. #>
function Invoke-Gate1HostProtection([switch]$LiveMode) {
    $runner = Join-Path $PSScriptRoot 'gate1-host-protection.js'
    $result = Invoke-Gate1HostNode -Runner $runner -LiveMode ([bool]$LiveMode)
    if ([string]::IsNullOrWhiteSpace($result.Json) -or $result.Json.Length -gt 65536) {
        throw 'Diagnostic did not produce a bounded report.'
    }
    try { $report = $result.Json | ConvertFrom-Json } catch { throw 'Diagnostic report was invalid.' }
    $expectedMode = 'prepare'
    $allowedResults = @('prepared', 'stopped')
    if ($LiveMode) { $expectedMode = 'live'; $allowedResults = @('completed', 'stopped') }
    if ($report.schemaVersion -ne 1 -or $report.scope -ne 'selected_login_host_access_only' -or
        $report.mode -ne $expectedMode -or $report.gate1Status -ne 'open' -or
        $report.result -notin $allowedResults) { throw 'Diagnostic report contract failed.' }
    $suffix = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff') + '-' + [Guid]::NewGuid().ToString('N')
    $reportDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp'
    [void][IO.Directory]::CreateDirectory($reportDirectory)
    $path = Join-Path $reportDirectory ('gate1-host-protection-' + $suffix + '.json')
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

# Dot-sourcing defines functions for mocked offline launcher tests without running Node.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $saved = Invoke-Gate1HostProtection -LiveMode:$Live
        Write-Output ('Report: ' + $saved.Path)
        exit $saved.ExitCode
    } catch {
        Write-Error 'Host diagnostic failed; no live retry was attempted.' -ErrorAction Continue
        exit 1
    }
}
