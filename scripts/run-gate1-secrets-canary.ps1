<#
Offline-default Preview missing-both-secrets canary. Review a local JSON profile,
then separately approve -Live -Approval. Secrets enter hidden prompts and stdin
only. No provider API, saved authentication files, deployment or configuration work.
#>
[CmdletBinding()]
param([switch]$Template, [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<# Run a fixed Node mode with bounded stdin, streaming output caps and a 90s deadline. Raw stderr is discarded. #>
function Invoke-Gate1SecretsNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -cnotin @('--prepare', '--template', '--review', '--live') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 16384) { throw 'Invalid canary input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-secrets-canary.js'
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
    $started = $false
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Canary child did not start.' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $outTask = $process.StandardOutput.BaseStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
        $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
        if ($InputJson) {
            $write = $process.StandardInput.WriteAsync($InputJson)
            if (-not $write.Wait(5000)) { throw 'Canary input deadline.' }
        }
        $process.StandardInput.Close()
        $outDone = $false; $errDone = $false; $errBytes = 0
        while (-not ($process.HasExited -and $outDone -and $errDone)) {
            if ($timer.ElapsedMilliseconds -ge 90000) { throw 'Canary child deadline.' }
            if (-not $outDone -and $outTask.IsCompleted) {
                $count = $outTask.GetAwaiter().GetResult()
                if ($count -eq 0) { $outDone = $true }
                else {
                    if ($output.Length + $count -gt 32768) { throw 'Canary output limit.' }
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
                    if ($errBytes -gt 8192) { throw 'Canary error output limit.' }
                    $errTask = $process.StandardError.BaseStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
                }
            }
            Start-Sleep -Milliseconds 10
        }
        $json = [Text.Encoding]::UTF8.GetString($output.ToArray())
        if ([string]::IsNullOrWhiteSpace($json)) { throw 'No bounded canary report.' }
        $null = ConvertFrom-Json -InputObject $json
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
        $InputJson = $null
        [Array]::Clear($errBuffer, 0, $errBuffer.Length)
        $output.Dispose()
        $process.Dispose()
    }
}

<# Recursively compare exact JSON keys/types/array order to independently pin review limits and scope. #>
function Test-Gate1SecretsEqual($Actual, $Expected) {
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
            if (-not (Test-Gate1SecretsEqual $Actual[$index] $Expected[$index])) { return $false }
        }
        return $true
    }
    if ($Expected -is [pscustomobject]) {
        $mapping = @{}
        foreach ($property in $Expected.PSObject.Properties) { $mapping[$property.Name] = $property.Value }
        $Expected = $mapping
    }
    if ($Expected -isnot [Collections.IDictionary] -or $Actual -isnot [pscustomobject]) { return $false }
    $keys = @($Actual.PSObject.Properties.Name)
    if ($keys.Count -ne $Expected.Count) { return $false }
    foreach ($key in $Expected.Keys) {
        if ($keys -cnotcontains $key -or -not (Test-Gate1SecretsEqual $Actual.$key $Expected[$key])) { return $false }
    }
    return $true
}

<# Check the reviewed profile, fixed request budget and offline state before any confirmation or credential prompt. #>
function Test-Gate1SecretsReview($Prepared, $canaryProfile) {
    $limits = @{ maxAppRequests = 4; maxProviderRequests = 0; maxConfigMutations = 0; concurrency = 1;
        requestMs = 10000; overallMs = 60000; buildBytes = 1048576; sessionBytes = 8192; probeBytes = 1536;
        headerBytes = 16384; inputBytes = 16384; reportBytes = 16384; profileAgeMs = 900000 }
    return (Test-Gate1SecretsEqual $Prepared.profile $canaryProfile) -and
        (Test-Gate1SecretsEqual $Prepared.limits $limits) -and
        (Test-Gate1SecretsEqual $Prepared.sequence @('buildBefore', 'probe1', 'probe2', 'buildAfter')) -and
        $canaryProfile.environment -ceq 'preview' -and $canaryProfile.caseId -ceq 'both_application_secrets_missing' -and
        $canaryProfile.accessMode -ceq 'automation_bypass' -and
        $canaryProfile.projectId -ceq 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom' -and
        $canaryProfile.teamId -ceq 'team_7o3efmwjZbMc2Bfy9qAzkc9q' -and
        $canaryProfile.hostname -cmatch '^job-application-tracker-[a-z0-9]{1,63}-track-the-app\.vercel\.app$' -and
        $Prepared.schemaVersion -eq 1 -and $Prepared.mode -ceq 'prepare' -and
        $Prepared.scope -ceq 'preview_missing_secrets_only' -and $Prepared.gate1Status -ceq 'open' -and
        $Prepared.liveApproved -is [bool] -and $Prepared.liveApproved -eq $false -and
        $Prepared.appRequests -eq 0 -and $Prepared.providerRequests -eq 0 -and
        $Prepared.nextStep -ceq 'obtain_separate_live_approval'
}

<# Prompt without echo or history; release the temporary BSTR and never read a saved authentication file. #>
function Read-Gate1SecretsCredential([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}

<# Review bounded local JSON first; only an exact approval and typed confirmation permit the stdin credential envelope. #>
function Invoke-Gate1SecretsCanary {
    if ($args.Count -ne 0 -or ($Template -and ($ProfilePath -or $Live -or $Approval)) -or
        ($Live -and (-not $ProfilePath -or $Approval -cnotmatch '^[a-f0-9]{64}$')) -or
        (-not $Live -and $Approval)) { throw 'Invalid canary mode.' }
    if ($Template) { return Invoke-Gate1SecretsNode '--template' }
    if (-not $ProfilePath) { return Invoke-Gate1SecretsNode '--prepare' }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Extension -ine '.json' -or $file.Length -gt 16384 -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a bounded local JSON profile.' }
    try { $canaryProfile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json }
    catch { throw 'Invalid local JSON profile.' }
    $review = Invoke-Gate1SecretsNode '--review' (ConvertTo-Json -InputObject $canaryProfile -Depth 10 -Compress)
    if ($review.ExitCode -ne 0) { throw 'Canary profile review failed.' }
    if (-not $Live) { return $review }
    $prepared = $review.Json | ConvertFrom-Json
    if ($prepared.approvalId -cne $Approval -or -not (Test-Gate1SecretsReview $prepared $canaryProfile)) {
        throw 'Approval must match the reviewed canary and runner.'
    }
    if ((Read-Host 'Type RUN PREVIEW CANARY ONCE for this separately approved trial') -cne 'RUN PREVIEW CANARY ONCE') {
        throw 'Canary was not confirmed.'
    }
    $probe = $null; $bypass = $null; $envelope = $null
    try {
        $probe = Read-Gate1SecretsCredential 'Dedicated Preview secret probe credential (hidden)'
        $bypass = Read-Gate1SecretsCredential 'Approved Deployment Protection automation bypass (hidden)'
        if ($probe -cnotmatch '^[a-f0-9]{64}$' -or $bypass -cnotmatch '^[\x21-\x7e]{16,512}$' -or $probe -ceq $bypass) {
            throw 'Canary credential contract failed.'
        }
        $envelope = ConvertTo-Json -Depth 10 -Compress -InputObject @{
            profile = $canaryProfile; approval = $Approval; liveApproved = $true;
            credentials = @{ probeSecret = $probe; bypassSecret = $bypass }
        }
        return Invoke-Gate1SecretsNode '--live' $envelope
    } finally { $probe = $null; $bypass = $null; $envelope = $null }
}

# Dot-sourcing exposes offline fixture seams without invoking the launcher.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1SecretsCanary
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) { Write-Warning 'Canary stopped. Preserve its sanitized report; do not rerun automatically.' }
        exit $result.ExitCode
    } catch {
        [Console]::Error.WriteLine('Canary preparation/execution failed. Do not rerun automatically.')
        exit 1
    }
}
