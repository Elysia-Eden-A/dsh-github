param([string]$Payload)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) { [Console]::Out.Write(($obj | ConvertTo-Json -Depth 6 -Compress)); exit 0 }
function Fail($m) { Emit @{ ok = $false; error = [string]$m } }

$dir = Join-Path $env:LOCALAPPDATA "dsh-github"
$file = Join-Path $dir "cred.txt"

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $req = $json | ConvertFrom-Json
} catch { Fail "bad payload: $($_.Exception.Message)" }

try {
  switch ([string]$req.action) {
    "save" {
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      $blob = @{ token = [string]$req.token; login = [string]$req.login } | ConvertTo-Json -Compress
      $sec = ConvertTo-SecureString $blob -AsPlainText -Force
      ConvertFrom-SecureString $sec | Set-Content -Path $file -Encoding ASCII
      Emit @{ ok = $true; login = [string]$req.login; path = $file }
    }
    "read" {
      if (-not (Test-Path $file)) { Emit @{ ok = $false; error = "not logged in" } }
      $raw = (Get-Content -Path $file -Raw)
      $raw = $raw -replace "^\uFEFF", ""
      $sec = ConvertTo-SecureString ($raw.Trim())
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
      $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      Emit @{ ok = $true; credential = $plain }
    }
    "clear" {
      Remove-Item $file -Force -ErrorAction SilentlyContinue
      Emit @{ ok = $true }
    }
    default { Fail "unknown action: $($req.action)" }
  }
} catch {
  Fail $_.Exception.Message
}
