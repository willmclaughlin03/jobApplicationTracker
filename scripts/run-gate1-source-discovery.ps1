<#
Offline by default. Use -Template for a blank local profile, then -ProfilePath
to review it. -Live -Approval <reviewed hash> requires separate live approval.
Credentials are prompted secretly and sent to the fixed Node child over stdin.
No .env/auth files, credential arguments, bypass tokens or automatic retries.
#>
[CmdletBinding()]
param([switch]$Template, [string]$ProfilePath, [switch]$Live, [string]$Approval)
$ErrorActionPreference = 'Stop'

<#
Run one fixed Node mode with a bounded stdin envelope; return sanitized stdout
and exit code. Drain both pipes, suppress raw stderr and kill after 200 seconds.
Runner paths are locally fixed; credentials never enter process arguments.
#>
function Invoke-Gate1DiscoveryNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -notin @('--prepare', '--template', '--review', '--live') -or
        [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt 16384) { throw 'Invalid diagnostic input.' }
    $runner = Join-Path $PSScriptRoot 'gate1-source-discovery.js'
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
    try {
        if (-not $process.Start()) { throw 'Diagnostic process did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputJson) { $process.StandardInput.Write($InputJson) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(200000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'Diagnostic process exceeded its deadline.'
        }
        $json = $stdout.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'Diagnostic output exceeded its limit.' }
        if ([string]::IsNullOrWhiteSpace($json)) { throw 'Diagnostic produced no sanitized report.' }
        return @{ Json = $json; ExitCode = $process.ExitCode }
    } finally {
        $InputJson = $null
        $process.Dispose()
    }
}

<#
Prompt for one secret without echo or history; release the temporary native BSTR.
Managed strings remain transient in process memory and are never persisted here.
#>
function Read-Gate1DiscoverySecret([string]$Prompt) {
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

<#
Review a local JSON profile before hidden prompts. A live invocation must supply
the exact reviewed hash. The Node runner validates it again before any HTTP and
persists only its own projected report under this worktree's .tmp directory.
#>
function Invoke-Gate1SourceDiscovery {
    if ($args.Count -ne 0 -or ($Template -and ($ProfilePath -or $Live -or $Approval)) -or
        ($Live -and (-not $ProfilePath -or $Approval -cnotmatch '^[a-f0-9]{64}$')) -or
        (-not $Live -and $Approval)) { throw 'Invalid discovery mode.' }
    if ($Template) { return Invoke-Gate1DiscoveryNode -Mode '--template' }
    if (-not $ProfilePath) { return Invoke-Gate1DiscoveryNode -Mode '--prepare' }
    $file = Get-Item -LiteralPath $ProfilePath
    if ($file.PSIsContainer -or $file.Extension -ine '.json' -or $file.Length -gt 8192 -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a bounded local JSON profile.' }
    try { $profile = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json }
    catch { throw 'Invalid local JSON profile.' }
    $profileJson = ConvertTo-Json -InputObject $profile -Depth 8 -Compress
    $review = Invoke-Gate1DiscoveryNode -Mode '--review' -InputJson $profileJson
    if ($review.ExitCode -ne 0) { throw 'Profile review failed.' }
    if (-not $Live) { return $review }
    $prepared = $review.Json | ConvertFrom-Json
    if ($prepared.mode -ne 'prepare' -or $prepared.liveApproved -ne $false -or
        $prepared.approvalId -cne $Approval) { throw 'Approval must match the reviewed profile and runner.' }
    $probe = $null
    $provider = $null
    $envelope = $null
    try {
        $probe = Read-Gate1DiscoverySecret 'Deployment GATE1_SOURCE_PROBE_SECRET (hidden)'
        $provider = Read-Gate1DiscoverySecret 'Vercel API token with approved read access (hidden)'
        if ($probe -cnotmatch '^[a-f0-9]{64}$' -or $provider -cnotmatch '^[A-Za-z0-9_-]{20,512}$' -or
            $probe -ceq $provider) { throw 'Diagnostic credential contract failed.' }
        $envelope = ConvertTo-Json -Depth 8 -Compress -InputObject @{
            profile = $profile; approval = $Approval
            credentials = @{ probeSecret = $probe; providerToken = $provider }
        }
        return Invoke-Gate1DiscoveryNode -Mode '--live' -InputJson $envelope
    } finally { $probe = $null; $provider = $null; $envelope = $null }
}

# Dot-sourcing defines helpers for offline tests only.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count -ne 0) { throw 'Unsupported arguments.' }
        $result = Invoke-Gate1SourceDiscovery
        Write-Output $result.Json
        if ($result.ExitCode -ne 0) { Write-Warning 'Diagnostic stopped. Share only the sanitized report; do not rerun automatically.' }
        exit $result.ExitCode
    } catch {
        Write-Error 'Discovery preparation/execution failed. No automatic retry was attempted.' -ErrorAction Continue
        exit 1
    }
}
