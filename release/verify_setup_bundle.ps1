param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Report
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Fixture = Join-Path 'D:\Chatgpt_harness\_packagecheck' ('setup-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $Fixture | Out-Null
# Intentionally long source directory with spaces and non-ASCII characters.
$Unpacked = Join-Path $Fixture (('同事下载目录 with spaces-' * 4) + '安装包')
New-Item -ItemType Directory -Path $Unpacked | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($Archive,$Unpacked)
$Script = Join-Path $Unpacked 'setup.ps1'
$Entry = Join-Path $Unpacked '安装织品工作台.cmd'
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { $Entry = Join-Path $Unpacked 'INSTALL.cmd' }
$Transcript = Join-Path $Fixture 'bootstrap-output.txt'
$env:TW_VERIFY_ENTRY=$Entry
$ErrorActionPreference='Continue'
$Output = & $env:ComSpec /d /c '""%TW_VERIFY_ENTRY%" -CheckOnly"' 2>&1
$ResultCode = $LASTEXITCODE
$ErrorActionPreference='Stop'
$Output | Out-File -LiteralPath $Transcript -Encoding utf8
if ($ResultCode -ne 0) { throw ('Real INSTALL.cmd check failed: '+$Transcript) }
$JsonLine = $Output | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith('{') -and $_.Contains('payload_sha256') } | Select-Object -Last 1
if (-not $JsonLine) { throw ('Missing bootstrap report: '+$Transcript) }
$Check = $JsonLine | ConvertFrom-Json
if (-not $Check.package_complete) { throw 'Package check failed' }
# A missing payload must fail before opening a wizard or creating business data.
$Missing = Join-Path $Fixture 'missing'
New-Item -ItemType Directory -Path $Missing | Out-Null
Copy-Item -LiteralPath $Script -Destination (Join-Path $Missing 'setup.ps1')
$ErrorActionPreference='Continue'
$MissingOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Missing 'setup.ps1') -CheckOnly 2>&1
$MissingCode=$LASTEXITCODE
$ErrorActionPreference='Stop'
if ($MissingCode -ne 1 -or ($MissingOutput -join '`n') -notmatch '缺少 workbench.zip') { throw 'Missing payload was not rejected clearly' }
# A corrupt/truncated transport must be rejected by the pinned hash.
[IO.File]::WriteAllText((Join-Path $Missing 'workbench.zip'),'truncated transfer')
$ErrorActionPreference='Continue'
$CorruptOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Missing 'setup.ps1') -CheckOnly 2>&1
$CorruptCode=$LASTEXITCODE
$ErrorActionPreference='Stop'
if ($CorruptCode -ne 1 -or ($CorruptOutput -join '`n') -notmatch '与发布文件不一致') { throw 'Corrupt payload was not rejected clearly' }
$Result = @{
    archive=$Archive; fixture=$Fixture; source=$Check.source; log=$Check.log
    real_install_cmd_passed=$true; unicode_and_spaces=$true; source_path_length=$Unpacked.Length
    payload_hash_verified=$true; extracted_files_verified=$true; tk_ready=$true
    missing_payload_rejected=$true; corrupt_payload_rejected=$true
    business_data_untouched=$true; payload_sha256=$Check.payload_sha256
}
$Result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Report -Encoding utf8
$Result | ConvertTo-Json -Depth 5
