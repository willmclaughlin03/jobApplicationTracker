param(
    [switch]$Template,
    [string]$ProfilePath,
    [ValidateSet('setup', 'build', 'inspect')][string]$Stage = 'setup',
    [switch]$Execute,
    [string]$Approval
)
$ErrorActionPreference = 'Stop'

<# Run the fixed Node supervisor with private stdin, bounded output and a final launcher deadline. #>
function Invoke-Gate1QualificationNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--template', '--prepare', '--prepare-build', '--prepare-inspect', '--setup', '--build', '--inspect') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 65536) { throw 'Invalid qualification input.' }
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not [IO.Path]::IsPathRooted($node.Source)) { throw 'Invalid runtime.' }
    $runner = Join-Path $PSScriptRoot 'gate1-build-qualification.js'
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node.Source
    $startInfo.Arguments = '"' + $runner + '" ' + $Mode
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $output = New-Object IO.MemoryStream
    $outBuffer = New-Object byte[] 8192
    $errBuffer = New-Object byte[] 4096
    $inputBytes = $null
    $started = $false
    # Node supervises Docker; an independent Linux timeout also terminates the container if this launcher dies.
    $deadlineMs = if ($Mode -ceq '--inspect') { 240000 } else { 1950000 }
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Supervisor did not start.' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
        $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
        if ($InputJson) {
            $inputBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($InputJson)
            $write = $process.StandardInput.BaseStream.WriteAsync($inputBytes, 0, $inputBytes.Length)
            if (-not $write.Wait(5000)) { throw 'Input deadline.' }
        }
        $process.StandardInput.Close()
        $outDone = $false
        $errDone = $false
        $errBytes = 0
        while (-not ($process.HasExited -and $outDone -and $errDone)) {
            if ($timer.ElapsedMilliseconds -ge $deadlineMs) { throw 'Supervisor deadline.' }
            if (-not $outDone -and $outTask.IsCompleted) {
                $count = $outTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $outDone = $true }
                else {
                    if ($output.Length + $count -gt 8388610) { throw 'Output limit.' }
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
                    if ($errBytes -gt 8192) { throw 'Error output limit.' }
                    $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
                }
            }
            if (-not ($process.HasExited -and $outDone -and $errDone)) { Start-Sleep -Milliseconds 20 }
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $json = [Text.Encoding]::UTF8.GetString($output.ToArray())
        try {
            if ([string]::IsNullOrWhiteSpace($json)) { throw 'Empty supervisor output.' }
            $null = $json | ConvertFrom-Json
        } catch {
            if ($exitCode -eq 0) { throw 'Invalid supervisor output.' }
            $json = '{}'
        }
        return @{ Json = $json; ExitCode = $exitCode }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill() }
        if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
        [Array]::Clear($outBuffer, 0, $outBuffer.Length)
        [Array]::Clear($errBuffer, 0, $errBuffer.Length)
        $output.Dispose()
        $process.Dispose()
    }
}

<# Read only a bounded profile JSON; reject environment/credential paths and reparse-point ancestors first. #>
function Read-Gate1QualificationProfile([string]$Location) {
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
    return [IO.File]::ReadAllText($file.FullName)
}

<# Preparation is the default. Execution requires the stage digest and its exact independently approved confirmation. #>
function Invoke-Gate1BuildQualification {
    if ($Template -or -not $ProfilePath) {
        if ($Execute -or $Approval -or ($Template -and $ProfilePath) -or $Stage -cne 'setup') { throw 'Conflicting modes.' }
        return Invoke-Gate1QualificationNode '--template'
    }
    $profileJson = Read-Gate1QualificationProfile $ProfilePath
    $prepareMode = if ($Stage -ceq 'setup') { '--prepare' } else { '--prepare-' + $Stage }
    $review = Invoke-Gate1QualificationNode $prepareMode $profileJson
    if ($review.ExitCode -ne 0) { throw 'Preparation failed.' }
    if (-not $Execute) {
        if ($Approval) { throw 'Approval requires execution mode.' }
        return $review
    }
    $prepared = $review.Json | ConvertFrom-Json
    $digest = if ($Stage -ceq 'setup') { $prepared.setupApproval } else { $prepared.approval }
    if ($Approval -cnotmatch '^[a-f0-9]{64}$' -or $digest -cne $Approval -or $prepared.gate1Status -cne 'open') {
        throw 'Approval mismatch.'
    }
    $confirmation = switch -CaseSensitive ($Stage) {
        'setup' { 'SET UP APPROVED OFFLINE TOOLCHAIN ONCE' }
        'build' { 'BUILD APPROVED SYNTHETIC SOURCE ONCE' }
        'inspect' { 'SCAN APPROVED OUTPUT ONCE' }
    }
    if ((Read-Host "Type $confirmation for this separately approved stage") -cne $confirmation) { throw 'Not confirmed.' }
    # Preserve the exact profile JSON. PowerShell must not normalize numeric types, extra keys or duplicate keys.
    $envelope = '{"profile":' + $profileJson + ',"approval":"' + $Approval + '","authorized":true}'
    try { return Invoke-Gate1QualificationNode ('--' + $Stage) $envelope }
    finally { $envelope = $null; $profileJson = $null }
}

# Dot-sourcing exposes synthetic test seams; no Docker command runs while loading the launcher.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1BuildQualification
        Write-Output $result.Json
        exit $result.ExitCode
    } catch {
        [Console]::Error.WriteLine('Qualification stopped. Preserve reservations and review container state; do not rerun automatically.')
        exit 1
    }
}
