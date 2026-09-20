<#
Defaults to offline preparation. Use the three switches together only after separate
live approval. Existing HMAC/Upstash JSON stays in process memory; no .env file is read.
The harness does not use the hosted probe secret or Vercel automation bypass token.
#>
param(
    [switch]$Live,
    [switch]$AttestConfigAndExclusiveSource,
    [switch]$AuthorizeChildTermination
)
$ErrorActionPreference = 'Stop'

<# Reads a hidden existing credential; clears the unmanaged copy and secure input. #>
function Read-Gate1RestartCredential([string]$Prompt) {
    $secureInput = Read-Host -Prompt $Prompt -AsSecureString
    $credentialBuffer = [IntPtr]::Zero
    try {
        $credentialBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureInput)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialBuffer)
    } finally {
        if ($credentialBuffer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialBuffer)
        }
        $secureInput.Dispose()
    }
}

$runnerPath = Join-Path $PSScriptRoot 'gate1-restart-continuity.js'
if (-not $Live) {
    if ($AttestConfigAndExclusiveSource -or $AuthorizeChildTermination) {
        throw 'Live acknowledgements require the Live switch.'
    }
    & node $runnerPath
    return
}
if (-not $AttestConfigAndExclusiveSource -or -not $AuthorizeChildTermination) {
    throw 'Live execution requires both explicit acknowledgements and separate operator approval.'
}

$credentialNames = @('GATE1_RESTART_LIVE_ALLOWED',
    'TEMPORARY_SESSION_CEILING_LOCAL_HMAC_SECRET', 'TEMPORARY_SESSION_CEILING_LOCAL_REDIS_SECRET')
$previousCredentials = @{}
foreach ($credentialName in $credentialNames) {
    $previousCredentials[$credentialName] = [Environment]::GetEnvironmentVariable($credentialName, 'Process')
}
try {
    $env:TEMPORARY_SESSION_CEILING_LOCAL_HMAC_SECRET = Read-Gate1RestartCredential 'Existing approved HMAC keyring JSON (hidden)'
    $env:TEMPORARY_SESSION_CEILING_LOCAL_REDIS_SECRET = Read-Gate1RestartCredential 'Existing approved Upstash JSON (hidden)'
    $env:GATE1_RESTART_LIVE_ALLOWED = '1'
    & node $runnerPath --live --attest-config-and-exclusive-source --authorize-child-termination
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Trial stopped. Preserve only the sanitized report; do not rerun automatically.'
    }
} finally {
    foreach ($credentialName in $credentialNames) {
        [Environment]::SetEnvironmentVariable($credentialName, $previousCredentials[$credentialName], 'Process')
    }
    $previousCredentials.Clear()
    Remove-Variable previousCredentials -ErrorAction SilentlyContinue
}
