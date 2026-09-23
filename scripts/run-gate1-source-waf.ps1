# Local preparation only. No credentials, provider queries or application requests.
# A separately reviewed/approved discovery profile is required before live work.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'No arguments are supported; this launcher is preparation only.' }
& node (Join-Path $PSScriptRoot 'gate1-source-waf.js') --prepare
if ($LASTEXITCODE -ne 0) { throw 'GATE-1 local preparation failed.' }
