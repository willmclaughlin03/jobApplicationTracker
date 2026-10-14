param(
    [switch]$Template,
    [string]$ProfilePath,
    [switch]$Execute,
    [string]$Approval
)
$ErrorActionPreference = 'Stop'

<# Run only the fixed supervisor with original JSON on stdin, bounded streams and a 120-second outer deadline. #>
function Invoke-Gate1DiagnosticNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--template', '--prepare', '--execute') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 65536) { throw 'Invalid diagnostic input.' }
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not [IO.Path]::IsPathRooted($node.Source)) { throw 'Invalid runtime.' }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node.Source
    $startInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'gate1-vercel-build-diagnostic.js') + '" ' + $Mode
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables.Clear()
    foreach ($name in @('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
        'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $startInfo.EnvironmentVariables[$name] = $value }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $output = New-Object IO.MemoryStream
    $outBuffer = New-Object byte[] 4096
    $errBuffer = New-Object byte[] 4096
    $inputBytes = $null
    $started = $false
    $outputLimit = if ($Mode -ceq '--prepare') { 65536 } else { 4096 }
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Supervisor did not start.' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
        $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
        if ($InputJson) {
            $inputBytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($InputJson)
            $write = $process.StandardInput.BaseStream.WriteAsync($inputBytes, 0, $inputBytes.Length)
            if (-not $write.Wait(5000)) { throw 'Input deadline.' }
        }
        $process.StandardInput.Close()
        $outDone = $false
        $errDone = $false
        $errBytes = 0
        while (-not ($process.HasExited -and $outDone -and $errDone)) {
            if ($timer.ElapsedMilliseconds -ge 120000) { throw 'Supervisor deadline.' }
            if (-not $outDone -and $outTask.IsCompleted) {
                $count = $outTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $outDone = $true }
                else {
                    if ($output.Length + $count -gt $outputLimit) { throw 'Output limit.' }
                    $output.Write($outBuffer, 0, $count)
                    $outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
                }
            }
            if (-not $errDone -and $errTask.IsCompleted) {
                $count = $errTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $errDone = $true }
                else {
                    $errBytes += $count
                    [Array]::Clear($errBuffer, 0, $errBuffer.Length)
                    if ($errBytes -gt 8388608) { throw 'Error output limit.' }
                    $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
                }
            }
            if (-not ($process.HasExited -and $outDone -and $errDone)) { Start-Sleep -Milliseconds 20 }
        }
        $process.WaitForExit()
        $json = (New-Object Text.UTF8Encoding($false, $true)).GetString($output.ToArray())
        if ([string]::IsNullOrWhiteSpace($json)) { throw 'Diagnostic stopped.' }
        $parsed = $json | ConvertFrom-Json
        $stoppedReport = $Mode -ceq '--execute' -and $process.ExitCode -eq 1 -and $parsed.result -ceq 'stopped'
        if ($process.ExitCode -ne 0 -and -not $stoppedReport) { throw 'Diagnostic stopped.' }
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill() }
        if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
        [Array]::Clear($outBuffer, 0, $outBuffer.Length)
        [Array]::Clear($errBuffer, 0, $errBuffer.Length)
        $output.Dispose()
        $process.Dispose()
    }
}

<# Read bounded public profile bytes with fatal UTF-8; retain original JSON for Node's duplicate/type checks. #>
function Read-Gate1DiagnosticProfile([string]$Location) {
    $file = Get-Item -LiteralPath $Location
    if ($file.PSIsContainer -or $file.Name -cnotmatch '^profile-[A-Za-z0-9_-]{1,120}\.json$' -or $file.Length -gt 32768) {
        throw 'Use a bounded profile JSON.'
    }
    $current = $file
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $current.Name -imatch '^(\.env(\..*)?|\.aws|\.ssh|\.codex|\.git|\.vercel|\.npmrc|\.netrc|auth\.json|credentials(\.json)?)$') {
            throw 'Forbidden input path.'
        }
        if ($current -is [IO.FileInfo]) { $current = $current.Directory } else { $current = $current.Parent }
    }
    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -ne $file.Length -or $stream.Length -gt 32768) { throw 'Changed profile.' }
        $bytes = New-Object byte[] ([int]$stream.Length + 1)
        $total = 0
        while ($total -lt $bytes.Length) {
            $count = $stream.Read($bytes, $total, $bytes.Length - $total)
            if ($count -eq 0) { break }
            $total += $count
        }
        if ($total -ne $file.Length) { throw 'Changed profile.' }
        return (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes, 0, $total)
    } finally { $stream.Dispose() }
}

<# Preparation remains separate; an execution digest and exact confirmation are mandatory for the single read. #>
function Invoke-Gate1VercelDiagnostic {
    if ($Template -or -not $ProfilePath) {
        if ($Execute -or $Approval -or ($Template -and $ProfilePath)) { throw 'Conflicting modes.' }
        return Invoke-Gate1DiagnosticNode '--template'
    }
    $profileJson = Read-Gate1DiagnosticProfile $ProfilePath
    $review = Invoke-Gate1DiagnosticNode '--prepare' $profileJson
    if (-not $Execute) {
        if ($Approval) { throw 'Approval requires execution mode.' }
        return $review
    }
    $prepared = $review.Json | ConvertFrom-Json
    if ($Approval -cnotmatch '^[a-f0-9]{64}$' -or $prepared.approval -cne $Approval -or $prepared.gate1Status -cne 'open') {
        throw 'Approval mismatch.'
    }
    if ((Read-Host 'Type READ APPROVED VERCEL FAILURE METADATA ONCE for this separately approved read') -cne
        'READ APPROVED VERCEL FAILURE METADATA ONCE') { throw 'Not confirmed.' }
    # Do not round-trip the profile through ConvertFrom-Json: duplicate keys and original types must survive.
    $envelope = '{"profile":' + $profileJson + ',"approval":"' + $Approval + '","authorized":true}'
    try { return Invoke-Gate1DiagnosticNode '--execute' $envelope }
    finally { $envelope = $null; $profileJson = $null }
}

# Dot-sourcing exposes fixture seams only; it never starts a diagnostic or reads a profile.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1VercelDiagnostic
        Write-Output $result.Json
        exit $result.ExitCode
    } catch {
        [Console]::Error.WriteLine('Diagnostic stopped. Preserve evidence and reservations; no automatic retry.')
        exit 1
    }
}
