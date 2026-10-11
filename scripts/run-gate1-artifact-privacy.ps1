param([switch]$Template, [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<# Run the fixed local Node runner with private stdin, bounded output and a hard child deadline. #>
function Invoke-Gate1ArtifactNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--template', '--prepare', '--live') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 131072) { throw 'Invalid diagnostic input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-artifact-privacy.js'
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'node.exe'
    $startInfo.Arguments = '"' + $runner + '" ' + $Mode
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $output = New-Object IO.MemoryStream
    $outBuffer = New-Object byte[] 4096
    $errBuffer = New-Object byte[] 4096
    $inputBytes = $null
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Diagnostic child did not start.' }
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
            if ($timer.ElapsedMilliseconds -ge 315000) { throw 'Diagnostic child deadline.' }
            if (-not $outDone -and $outTask.IsCompleted) {
                $count = $outTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $outDone = $true }
                else {
                    if ($output.Length + $count -gt 131072) { throw 'Output limit.' }
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
        try { $null = $json | ConvertFrom-Json } catch { throw 'Invalid diagnostic output.' }
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill() }
        if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
        [Array]::Clear($errBuffer, 0, $errBuffer.Length)
        $output.Dispose()
        $process.Dispose()
    }
}

<# Prompt locally without history/echo; release the temporary BSTR. Managed strings remain process-local. #>
function Read-Gate1ArtifactPrivate([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}

<# Review the approved profile offline before prompting; live execution consumes its reservation once. #>
function Invoke-Gate1ArtifactPrivacy {
    if ($Template) {
        if ($Live -or $ProfilePath -or $Approval) { throw 'Conflicting modes.' }
        return Invoke-Gate1ArtifactNode '--template'
    }
    if (-not $ProfilePath) {
        if ($Live -or $Approval) { throw 'Live mode requires a profile.' }
        return Invoke-Gate1ArtifactNode '--template'
    }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Name -cnotmatch '^profile-[A-Za-z0-9_-]{1,120}\.json$' -or $file.Length -gt 16384 -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a bounded local JSON profile.' }
    $artifactProfile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
    $review = Invoke-Gate1ArtifactNode '--prepare' (ConvertTo-Json -InputObject $artifactProfile -Depth 10 -Compress)
    if ($review.ExitCode -ne 0) { throw 'Profile review failed.' }
    if (-not $Live) {
        if ($Approval) { throw 'Approval requires explicit live mode.' }
        return $review
    }
    $prepared = $review.Json | ConvertFrom-Json
    if ($Approval -cnotmatch '^[a-f0-9]{64}$' -or $prepared.approvalId -cne $Approval -or
        $prepared.mode -cne 'prepare' -or $prepared.liveApproved -ne $false -or
        $prepared.appRequests -ne 0 -or $prepared.providerRequests -ne 0 -or
        $prepared.nextStep -cne 'obtain_separate_live_approval') { throw 'Approval mismatch.' }
    if ((Read-Host 'Type RUN APPROVED ARTIFACT SCAN ONCE for the separately approved scan') -cne
        'RUN APPROVED ARTIFACT SCAN ONCE') { throw 'Not confirmed.' }
    $credentials = @{}
    $comparisons = @()
    $envelope = $null
    try {
        foreach ($environment in @('production', 'preview')) {
            $credentials[$environment] = Read-Gate1ArtifactPrivate "$environment existing Protection Bypass for Automation (hidden)"
        }
        foreach ($reference in $artifactProfile.comparisons) {
            $comparisons += @{
                environment = $reference.environment
                label = $reference.label
                value = Read-Gate1ArtifactPrivate "$($reference.environment) deployed value for comparison $($reference.label) (hidden; never paste into chat)"
            }
        }
        $envelope = ConvertTo-Json -Depth 10 -Compress -InputObject @{
            profile = $artifactProfile; approval = $Approval; liveApproved = $true
            credentials = $credentials; comparisons = $comparisons
        }
        return Invoke-Gate1ArtifactNode '--live' $envelope
    } finally {
        $credentials.Clear()
        foreach ($reference in $comparisons) { $reference.value = $null }
        $comparisons = $null
        $envelope = $null
    }
}

# Dot-sourcing exposes only local test seams. No live call is made without explicit mode and approval.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1ArtifactPrivacy
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) { Write-Warning 'Artifact scan stopped. Preserve its report; do not rerun automatically.' }
        exit $result.ExitCode
    } catch {
        [Console]::Error.WriteLine('Artifact preparation/execution failed. Do not rerun automatically.')
        exit 1
    }
}
