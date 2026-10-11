param([switch]$Template, [string]$ProfilePath, [switch]$Inspect, [string]$Approval)
$ErrorActionPreference = 'Stop'

<# Execute the fixed local scanner with private stdin, bounded streams and a 135-second kill deadline. #>
function Invoke-Gate1BuildArtifactNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--template', '--prepare', '--inspect') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 65536) { throw 'Invalid scanner input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-build-artifact-privacy.js'
    $node = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not [IO.Path]::IsPathRooted($node.Source)) { throw 'Node runtime must resolve to an absolute path.' }
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
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Scanner child did not start.' }
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
            if ($timer.ElapsedMilliseconds -ge 135000) { throw 'Scanner child deadline.' }
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
        $json = [Text.Encoding]::UTF8.GetString($output.ToArray())
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        try {
            # ConvertFrom-Json accepts blank input; require an actual JSON payload on success.
            if ([string]::IsNullOrWhiteSpace($json)) { throw 'Invalid scanner output.' }
            $null = $json | ConvertFrom-Json
        } catch {
            if ($exitCode -eq 0) { throw 'Invalid scanner output.' }
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

<# Read a comparison value without terminal echo/history; never create a new deployment credential. #>
function Read-Gate1BuildComparison([string]$Label) {
    $secure = Read-Host "Existing approved comparison '$Label' (hidden; never paste it into chat)" -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}

<# Prepare by default; content inspection requires a reviewed profile, matching digest and explicit confirmation. #>
function Invoke-Gate1BuildArtifactPrivacy {
    if ($Template -or -not $ProfilePath) {
        if ($Inspect -or $Approval -or ($Template -and $ProfilePath)) { throw 'Conflicting modes.' }
        return Invoke-Gate1BuildArtifactNode '--template'
    }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Name -cnotmatch '^profile-[A-Za-z0-9_-]{1,120}\.json$' -or
        $file.Length -gt 16384 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Use a bounded local JSON profile.'
    }
    $artifactProfile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
    $review = Invoke-Gate1BuildArtifactNode '--prepare' (ConvertTo-Json -InputObject $artifactProfile -Depth 10 -Compress)
    if ($review.ExitCode -ne 0) { throw 'Profile review failed.' }
    if (-not $Inspect) {
        if ($Approval) { throw 'Approval requires explicit inspection mode.' }
        return $review
    }
    $prepared = $review.Json | ConvertFrom-Json
    if ($Approval -cnotmatch '^[a-f0-9]{64}$' -or $prepared.approvalId -cne $Approval -or
        $prepared.mode -cne 'prepare' -or $prepared.inspectionApproved -ne $false -or
        $prepared.artifactReads -ne 0 -or $prepared.limits.maxAppRequests -ne 0 -or
        $prepared.limits.maxProviderRequests -ne 0 -or $prepared.limits.maxBuilds -ne 0 -or
        $prepared.limits.maxDeployments -ne 0 -or
        $prepared.nextStep -cne 'obtain_separate_content_inspection_approval') { throw 'Approval mismatch.' }
    if ((Read-Host 'Type SCAN APPROVED OUTPUT ONCE for this separately approved local content inspection') -cne
        'SCAN APPROVED OUTPUT ONCE') { throw 'Not confirmed.' }
    $comparisons = @()
    $envelope = $null
    $value = $null
    try {
        foreach ($label in $artifactProfile.comparisonLabels) {
            $value = Read-Gate1BuildComparison $label
            if ($value.Length -lt 16 -or $value.Length -gt 4096 -or $value -cnotmatch '^[\x20-\x7e]+$') {
                throw 'Invalid comparison format.'
            }
            $comparisons += @{ label = $label; value = $value }
            $value = $null
        }
        $envelope = ConvertTo-Json -Depth 10 -Compress -InputObject @{
            profile = $artifactProfile; approval = $Approval; inspectionApproved = $true; comparisons = $comparisons
        }
        $result = Invoke-Gate1BuildArtifactNode '--inspect' $envelope
        foreach ($comparison in $comparisons) {
            if ($result.Json.Contains($comparison.value)) { throw 'Private output suppressed.' }
        }
        return $result
    } finally { $comparisons = $null; $envelope = $null; $value = $null }
}

# Dot-sourcing exposes launcher fixtures without touching an artifact directory.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1BuildArtifactPrivacy
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) { Write-Warning 'Scan stopped. Preserve its report/reservation; do not rerun automatically.' }
        exit $result.ExitCode
    } catch {
        [Console]::Error.WriteLine('Artifact preparation/inspection failed. Preserve any reservation; do not rerun automatically.')
        exit 1
    }
}
