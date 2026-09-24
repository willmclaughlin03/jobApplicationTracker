<#
Offline by default: -Template creates an unapproved profile; -ProfilePath reviews
it. Separately approved -Live -Approval permits one provider query, zero app
requests. Enter only the Vercel API token, through the hidden prompt.
#>
[CmdletBinding()]
param([switch]$Template, [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<#
Run a fixed Node mode with bounded stdin. Drain stdout/stderr concurrently but
never print raw stderr. The 45-second child deadline includes input delivery;
the runner separately bounds its single HTTP request and execution time.
#>
function Invoke-Gate1AccessNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -notin @('--prepare', '--template', '--review', '--live') -or
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
Validate/review the local profile before prompting. Live approval must match the
exact current runner/profile; Node checks again. No deployment/probe credential
is requested. Only the runner's sanitized report is returned and saved locally.
#>
function Invoke-Gate1ProviderAccess {
    if ($args.Count -ne 0 -or ($Template -and ($ProfilePath -or $Live -or $Approval)) -or
        ($Live -and (-not $ProfilePath -or $Approval -cnotmatch '^[a-f0-9]{64}$')) -or
        (-not $Live -and $Approval)) { throw 'Invalid provider diagnostic mode.' }
    if ($Template) { return Invoke-Gate1AccessNode -Mode '--template' }
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
    if ($prepared.mode -ne 'prepare' -or $prepared.scope -ne 'provider_metrics_access_only' -or
        $prepared.liveApproved -ne $false -or $prepared.approvalId -cne $Approval -or
        $prepared.limits.maxAppRequests -ne 0 -or $prepared.limits.maxProviderRequests -ne 1) {
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
