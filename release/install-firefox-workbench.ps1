param(
  [string]$XpiPath = "",
  [switch]$UseInstallDirectoryPolicy,
  [string]$FirefoxPath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root "browser_extension\manifest.json"
$manifestText = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8)
$manifest = $manifestText | ConvertFrom-Json
$geckoId = [string]$manifest.browser_specific_settings.gecko.id
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($XpiPath)) {
  $XpiPath = Join-Path $PSScriptRoot ("Temu-data-collector-firefox-{0}.xpi" -f $version)
}
$XpiPath = [IO.Path]::GetFullPath($XpiPath)
if (-not (Test-Path -LiteralPath $XpiPath -PathType Leaf)) {
  throw "找不到 Firefox 安装包：$XpiPath。请先运行 package_firefox_extension.py。"
}

$gptManifestPath = Join-Path $root "gpt_chrome_extension\manifest.json"
$gptManifestText = [IO.File]::ReadAllText($gptManifestPath, [Text.Encoding]::UTF8)
$gptManifest = $gptManifestText | ConvertFrom-Json
$gptGeckoId = [string]$gptManifest.browser_specific_settings.gecko.id
$gptVersion = [string]$gptManifest.version
$gptXpiPath = Join-Path $PSScriptRoot "Temu-gpt-image-helper-firefox-latest.xpi"
if (-not (Test-Path -LiteralPath $gptXpiPath -PathType Leaf)) {
  $gptXpiPath = Join-Path $PSScriptRoot ("Temu-gpt-image-helper-firefox-{0}.xpi" -f $gptVersion)
}
if (-not (Test-Path -LiteralPath $gptXpiPath -PathType Leaf)) {
  throw "找不到 GPT 生图助手 Firefox 安装包：$gptXpiPath。请先运行 package_firefox_gpt_extension.py。"
}

$installUrl = ([Uri]$XpiPath).AbsoluteUri
$gptInstallUrl = ([Uri]$gptXpiPath).AbsoluteUri
$json = '{"policies":{"ExtensionSettings":{"' + $geckoId + '":{"installation_mode":"normal_installed","install_url":"' + $installUrl + '"},"' + $gptGeckoId + '":{"installation_mode":"normal_installed","install_url":"' + $gptInstallUrl + '"}}}}'

if ($UseInstallDirectoryPolicy) {
  if ([string]::IsNullOrWhiteSpace($FirefoxPath)) {
    $candidates = @(
      "C:\Program Files\Firefox Developer Edition\firefox.exe",
      "C:\Program Files\Mozilla Firefox ESR\firefox.exe",
      "C:\Program Files\Mozilla Firefox\firefox.exe"
    )
    $FirefoxPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  }
  if ([string]::IsNullOrWhiteSpace($FirefoxPath) -or -not (Test-Path -LiteralPath $FirefoxPath -PathType Leaf)) {
    throw "未找到指定的 Firefox 安装目录：$FirefoxPath"
  }
  $firefoxPath = (Resolve-Path -LiteralPath $FirefoxPath).Path
  $distribution = Join-Path (Split-Path -Parent $firefoxPath) "distribution"
  New-Item -ItemType Directory -Path $distribution -Force | Out-Null
  $policyPath = Join-Path $distribution "policies.json"
  Set-Content -LiteralPath $policyPath -Value $json -Encoding UTF8
  Write-Output "已写入 Firefox 安装目录策略：$policyPath"
  $extensionsDirectory = Join-Path $distribution "extensions"
  New-Item -ItemType Directory -Path $extensionsDirectory -Force | Out-Null
  $installedXpiPath = Join-Path $extensionsDirectory ($geckoId + ".xpi")
  Copy-Item -LiteralPath $XpiPath -Destination $installedXpiPath -Force
  Write-Output "已部署 Firefox 扩展：$installedXpiPath"
  $gptInstalledXpiPath = Join-Path $extensionsDirectory ($gptGeckoId + ".xpi")
  Copy-Item -LiteralPath $gptXpiPath -Destination $gptInstalledXpiPath -Force
  Write-Output "已部署 Firefox 生图助手：$gptInstalledXpiPath"
} else {
  # Firefox policies are read from the current-user policy hive as well as the
  # machine hive.  This avoids changing Firefox signature enforcement or asking
  # for administrator access just to keep this local extension installed.
  $registryPath = "HKCU:\Software\Policies\Mozilla\Firefox"
  try {
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name "ExtensionSettings" -PropertyType MultiString -Value $json -Force | Out-Null
  } catch {
    throw "无法写入当前用户的 Firefox 自动安装策略（Windows 拒绝访问）。请以管理员身份运行 PowerShell，然后执行：pwsh -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\install-firefox-workbench.ps1`" -UseInstallDirectoryPolicy。不会关闭浏览器，也不会关闭扩展签名校验。原始错误：$($_.Exception.Message)"
  }
  Write-Output "已写入当前 Windows 用户的 Firefox 自动安装策略。"
}
Write-Output "扩展：$geckoId v$version"
Write-Output "安装源：$installUrl"
Write-Output "生图助手：$gptGeckoId v$gptVersion"
Write-Output "生图助手安装源：$gptInstallUrl"
Write-Output "请完全退出并重新打开 Firefox 一次，策略会自动安装并在后续 XPI 版本变化时更新。"
