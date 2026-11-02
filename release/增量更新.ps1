param([string]$Target, [switch]$CheckOnly, [switch]$NoLaunch, [switch]$Yes)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ExpectedManifestHash = '__MANIFEST_SHA256__'
function FileHash([string]$Path) {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    $Stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $Stream.Dispose(); $Hasher.Dispose() }
}
function IsWorkbench([string]$Path) {
    return $Path -and (Test-Path -LiteralPath (Join-Path $Path 'workbench-release.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path 'runtime\python\python.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path 'launcher.py') -PathType Leaf)
}
try {
    $ManifestPath = Join-Path $PSScriptRoot 'delta-manifest.json'
    if ((FileHash $ManifestPath) -ne $ExpectedManifestHash) { throw '更新文件不完整，请重新完整解压收到的更新ZIP。' }
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($Name in @('delta_update_workbench.py','workbench_processes.py')) {
        if ((FileHash (Join-Path $PSScriptRoot $Name)) -ne $Manifest.helpers.$Name) { throw '更新器文件不完整，请重新解压。' }
    }
    if (-not $Target) {
        $Desktop = [Environment]::GetFolderPath('Desktop')
        $LinkPath = Join-Path $Desktop '织品工作台.lnk'
        if (Test-Path -LiteralPath $LinkPath -PathType Leaf) {
            $Link = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath)
            if (IsWorkbench $Link.WorkingDirectory) { $Target = $Link.WorkingDirectory }
        }
    }
    if (-not (IsWorkbench $Target)) {
        if ($Yes) { throw '无法确认原工作台目录；无人值守更新请通过 -Target 指定有效安装目录。' }
        Add-Type -AssemblyName System.Windows.Forms
        $Picker = New-Object System.Windows.Forms.FolderBrowserDialog
        $Picker.Description = '请选择原来的织品工作台安装文件夹（不要选择这次解压的更新包）'
        if ($Picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { throw '已取消选择安装目录。' }
        $Target = $Picker.SelectedPath
        $Picker.Dispose()
    }
    if (-not (IsWorkbench $Target)) { throw '所选文件夹不是完整的织品工作台安装目录。' }
    if (-not $CheckOnly -and -not $Yes) {
        Add-Type -AssemblyName System.Windows.Forms
        $Prompt = '将更新此工作台：' + "`r`n" + $Target + "`r`n`r`n" +
            $Manifest.base_version + ' → ' + $Manifest.target_version + "`r`n" +
            '账号、店铺、任务与图片保持原位。请先正常结束任务，并关闭专用浏览器和店小秘工具。现在开始更新？'
        if ([Windows.Forms.MessageBox]::Show($Prompt,'织品工作台更新',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Question) -ne [Windows.Forms.DialogResult]::Yes) {
            Write-Host '已取消，本次没有更新程序。'; exit 0
        }
    }
    foreach ($Name in @('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY','TEMU_WORKBENCH_DATA')) {
        [Environment]::SetEnvironmentVariable($Name,$null,'Process')
    }
    $Python = Join-Path $Target 'runtime\python\python.exe'
    $Helper = Join-Path $PSScriptRoot 'delta_update_workbench.py'
    Write-Host '正在检查更新文件和原程序，请稍候……'
    if ($CheckOnly) {
        & $Python -E -X utf8 -B $Helper --package $PSScriptRoot --target $Target --check
    } elseif ($NoLaunch) {
        & $Python -E -X utf8 -B $Helper --package $PSScriptRoot --target $Target --apply
    } else {
        & $Python -E -X utf8 -B $Helper --package $PSScriptRoot --target $Target --apply --launch
    }
    if ($LASTEXITCODE -ne 0) { throw '更新没有完成。请保留上面的提示和程序旁的备份文件夹，交给负责人。' }
    if (-not $CheckOnly -and -not $Yes) { [Windows.Forms.MessageBox]::Show('更新完成。以后仍使用原来的桌面“织品工作台”。','织品工作台更新') | Out-Null }
    exit 0
} catch {
    Write-Host ('更新未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
