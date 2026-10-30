Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$ErrorActionPreference = 'Stop'
$form = New-Object Windows.Forms.Form
$form.Text = '长路径迁移助手'
$form.Size = New-Object Drawing.Size(800,675)
$form.MinimumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI',10)
function Label($text,$x,$y,$w,$h) {
 $c = New-Object Windows.Forms.Label
 $c.Text=$text; $c.SetBounds($x,$y,$w,$h); $form.Controls.Add($c)
}
Label '长路径迁移助手' 20 16 730 32
Label '支持批量迁移子文件夹、长路径、自动重试；源文件始终保留。' 20 52 740 28
Label '源文件夹（可直接粘贴完整路径）' 20 92 600 25
$src = New-Object Windows.Forms.TextBox
$src.SetBounds(20,122,640,30); $form.Controls.Add($src)
Label '目标位置（子文件夹模式会直接放入这里）' 20 162 680 25
$dst = New-Object Windows.Forms.TextBox
$dst.SetBounds(20,192,640,30); $form.Controls.Add($dst)
function Browse($box,$y) {
 $b=New-Object Windows.Forms.Button; $b.Text='浏览'; $b.SetBounds(674,$y,80,30)
 $b.Tag=$box
 $b.Add_Click({$d=New-Object Windows.Forms.FolderBrowserDialog; if([IO.Directory]::Exists($this.Tag.Text)){$d.SelectedPath=$this.Tag.Text}; if($d.ShowDialog() -eq 'OK'){$this.Tag.Text=$d.SelectedPath}; $d.Dispose()})
 $form.Controls.Add($b)
}
Browse $src 122
Browse $dst 192
$batch=New-Object Windows.Forms.CheckBox; $batch.Text='迁移源文件夹下的所有直属子文件夹（不复制源目录内的散文件）'; $batch.Checked=$true; $batch.SetBounds(20,232,740,28); $form.Controls.Add($batch)
Label '目标中已有同名文件夹时，自动改用带编号的新名称。源文件始终保留。' 20 268 740 28
$start=New-Object Windows.Forms.Button; $start.Text='开始复制'; $start.SetBounds(20,310,130,36); $form.Controls.Add($start)
$stop=New-Object Windows.Forms.Button; $stop.Text='停止'; $stop.SetBounds(160,310,90,36); $stop.Enabled=$false; $form.Controls.Add($stop)
$open=New-Object Windows.Forms.Button; $open.Text='打开结果'; $open.SetBounds(260,310,120,36); $open.Enabled=$false; $form.Controls.Add($open)
$status=New-Object Windows.Forms.Label; $status.Text='等待开始'; $status.SetBounds(20,358,730,45); $form.Controls.Add($status)
$logview=New-Object Windows.Forms.TextBox; $logview.Multiline=$true; $logview.ReadOnly=$true; $logview.ScrollBars='Both'; $logview.WordWrap=$false; $logview.SetBounds(20,410,734,195); $logview.Anchor='Top,Bottom,Left,Right'; $form.Controls.Add($logview)
$script:plans=@(); $script:position=0; $script:failures=0; $script:skipped=0; $script:lastMode=$null; $script:proc=$null; $script:target=$null; $script:log=$null; $script:stopped=$false; $script:lastSource=''; $script:lastDest=''
# Keep user-entered paths separately from the current copy plan.
$script:pathSettingsFile=Join-Path $env:LOCALAPPDATA 'LongPathMover\settings.json'
function SavePathSettings {
 $temporary=$null
 try {
  $directory=[IO.Path]::GetDirectoryName($script:pathSettingsFile)
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $settings=@{source=$src.Text; destination=$dst.Text; batch=[bool]$batch.Checked; version=1}
  $temporary=$script:pathSettingsFile+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temporary,($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  if([IO.File]::Exists($script:pathSettingsFile)) {
   [IO.File]::Replace($temporary,$script:pathSettingsFile,$null)
  } else {[IO.File]::Move($temporary,$script:pathSettingsFile)}
 } catch {
  if(-not $script:proc){$status.Text='路径暂未保存：'+$_.Exception.Message}
 } finally {
  if($temporary -and [IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}
 }
}
if([IO.File]::Exists($script:pathSettingsFile)) {
 try {
  $remembered=[IO.File]::ReadAllText($script:pathSettingsFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
  if($remembered.source -is [string]){$src.Text=$remembered.source}
  if($remembered.destination -is [string]){$dst.Text=$remembered.destination}
  if($remembered.batch -is [bool]){$batch.Checked=$remembered.batch}
  $status.Text='已恢复上次路径；修改后会自动保存。'
 } catch {$status.Text='上次路径记录无法读取，请重新选择路径。'}
}
$pathSaveTimer=New-Object Windows.Forms.Timer
$pathSaveTimer.Interval=600
$pathSaveTimer.Add_Tick({$pathSaveTimer.Stop(); SavePathSettings})
$rememberChange={$pathSaveTimer.Stop(); $pathSaveTimer.Start()}
$src.Add_TextChanged($rememberChange)
$dst.Add_TextChanged($rememberChange)
$batch.Add_CheckedChanged($rememberChange)

function CleanPath($s) {
 $p=$s.Trim().Trim('"')
 if($p.StartsWith('\\?\UNC\')){$p='\\'+$p.Substring(8)} elseif($p.StartsWith('\\?\')){$p=$p.Substring(4)}
 if($p -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)'){throw '请输入完整的盘符路径或网络共享路径。'}
 [IO.Path]::GetFullPath($p).TrimEnd('\')+'\'
}
function CheckAncestors($p) {
 $q=$p.TrimEnd('\')
 if($q -match '^[A-Za-z]:$'){$q+='\'}
 while($q) {
  if([IO.Directory]::Exists($q)) {
   if(([IO.File]::GetAttributes($q) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw '源路径和目标位置不能经过链接或目录联接，请选择实际文件夹路径。'}
  }
  $parent=[IO.Directory]::GetParent($q)
  if($null -eq $parent){break}; $q=$parent.FullName
 }
}


function ExtendedPath($p) {
 if($p.StartsWith('\\?\')){return $p}
 if($p.StartsWith('\\')){return '\\?\UNC\'+$p.Substring(2)}
 return '\\?\'+$p
}
function QuoteArg($p) { '"'+($p -replace '(\\+)$','$1$1')+'"' }
function MakePlans($s,$d,$isBatch) {
 $script:skipped=0
 if($isBatch) {
  $paths=[IO.Directory]::GetDirectories((ExtendedPath $s))
  foreach($path in $paths) {
   if(([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){$script:skipped++; continue}
   $plain=$path
   if($plain.StartsWith('\\?\UNC\')){$plain='\\'+$plain.Substring(8)} elseif($plain.StartsWith('\\?\')){$plain=$plain.Substring(4)}
   $name=($plain.TrimEnd('\') -split '\\')[-1]
   $to=$d.TrimEnd('\')+'\'+$name
   if([IO.Directory]::Exists((ExtendedPath $to)) -or [IO.File]::Exists((ExtendedPath $to))) {
    $stem=$name; if($stem.Length -gt 180){$stem=$stem.Substring(0,180)}
    do {$to=$d.TrimEnd('\')+'\'+$stem+'_迁移_'+[Guid]::NewGuid().ToString('N')} while([IO.Directory]::Exists((ExtendedPath $to)) -or [IO.File]::Exists((ExtendedPath $to)))
   }
   [PSCustomObject]@{Source=$plain; Target=$to; Claimed=$false}
  }
 } else {
  $name=($s.TrimEnd('\') -split '\\')[-1] -replace '[:*?"<>|]','_'
  if($name.Length -gt 60){$name=$name.Substring(0,60)}
  [PSCustomObject]@{Source=$s; Target=($d.TrimEnd('\')+'\'+$name+'_迁移_'+[Guid]::NewGuid().ToString('N')); Claimed=$false}
 }
}
function StartNext {
 $plan=$script:plans[$script:position]
 CheckAncestors $plan.Target
 if(-not $plan.Claimed) {
  if([IO.Directory]::Exists((ExtendedPath $plan.Target)) -or [IO.File]::Exists((ExtendedPath $plan.Target))){throw '目标目录在准备期间已出现，请重新选择目标位置后开始。'}
  [IO.Directory]::CreateDirectory((ExtendedPath $plan.Target)) | Out-Null
  $plan.Claimed=$true
 }
 $si=New-Object Diagnostics.ProcessStartInfo
 $si.FileName=Join-Path $env:SystemRoot 'System32\robocopy.exe'
 $si.Arguments=(QuoteArg $plan.Source)+' '+(QuoteArg $plan.Target)+' /E /Z /COPY:DAT /DCOPY:DAT /R:2 /W:2 /XJ /BYTES /UNILOG+:'+(QuoteArg $script:log)
 $si.UseShellExecute=$false; $si.CreateNoWindow=$true
 $script:proc=[Diagnostics.Process]::Start($si)
 $status.Text=('正在复制第 {0}/{1} 个文件夹：{2}' -f ($script:position+1),$script:plans.Count,$plan.Source)
}
function SetRunning($active) {
 $start.Enabled=-not $active; $stop.Enabled=$active; $src.Enabled=-not $active; $dst.Enabled=-not $active; $batch.Enabled=-not $active
 foreach($control in $form.Controls){if($control -is [Windows.Forms.Button] -and $control.Text -eq '浏览'){$control.Enabled=-not $active}}
}

$timer=New-Object Windows.Forms.Timer; $timer.Interval=1000
$timer.Add_Tick({
 try {
  if($script:log -and (Test-Path -LiteralPath $script:log)) {
   $logview.Text=(Get-Content -LiteralPath $script:log -Encoding Unicode -Tail 70 -ErrorAction SilentlyContinue) -join "`r`n"
   $logview.SelectionStart=$logview.TextLength; $logview.ScrollToCaret()
  }
  if($script:proc -and $script:proc.HasExited) {
   $code=$script:proc.ExitCode
   $script:proc.Dispose(); $script:proc=$null
   if($code -ge 8){$script:failures++}
   if(-not $script:stopped -and $script:position+1 -lt $script:plans.Count) {
    $script:position++; StartNext; return
   }
   $timer.Stop(); SetRunning $false; $open.Enabled=$true
   if($script:stopped){$status.Text='已停止，源文件保留。保持模式和路径不变，点击“重试 / 继续”。'}
   elseif($script:failures -gt 0){$status.Text=('有 {0} 个文件夹复制失败，请查看日志并重试。' -f $script:failures)}
   else{$status.Text=('复制完成，共 {0} 个文件夹；跳过 {1} 个直属链接。请检查日志和目标内容。' -f $script:plans.Count,$script:skipped)}
   $start.Text='重试 / 继续'
  }
 } catch {$timer.Stop(); SetRunning $false; $status.Text='任务中断：'+$_.Exception.Message}
})
$start.Add_Click({
 $pathSaveTimer.Stop(); SavePathSettings
 try {
  $s=CleanPath $src.Text; $d=CleanPath $dst.Text
  if($s.StartsWith($d,[StringComparison]::OrdinalIgnoreCase) -or $d.StartsWith($s,[StringComparison]::OrdinalIgnoreCase)){throw '源文件夹与目标位置不能相同，也不能互相包含。'}
  CheckAncestors $s; CheckAncestors $d
  if(-not [IO.Directory]::Exists($d)){throw '请选择一个已存在的目标位置。'}
  if($s -ne $script:lastSource -or $d -ne $script:lastDest -or $batch.Checked -ne $script:lastMode -or -not $script:plans.Count) {
   $script:plans=@(MakePlans $s $d $batch.Checked)
   if(-not $script:plans.Count){throw '源文件夹中没有可迁移的直属子文件夹（链接会跳过）。'}
   $script:target=$d.TrimEnd('\'); if($script:target -match '^[A-Za-z]:$'){$script:target+='\'}
   if(-not $batch.Checked){$script:target=$script:plans[0].Target}
   $logdir=Join-Path $env:LOCALAPPDATA 'LongPathMover\Logs'
   [IO.Directory]::CreateDirectory($logdir) | Out-Null
   $script:log=Join-Path $logdir ([Guid]::NewGuid().ToString('N')+'.log')
   $script:lastSource=$s; $script:lastDest=$d; $script:lastMode=$batch.Checked
  }
  $script:position=0; $script:failures=0; $script:stopped=$false
  StartNext
  SetRunning $true; $open.Enabled=$true
  $timer.Start()
 } catch {[Windows.Forms.MessageBox]::Show($_.Exception.Message,'无法开始') | Out-Null}
})
$stop.Add_Click({if($script:proc -and -not $script:proc.HasExited){$script:stopped=$true; $script:proc.Kill(); $status.Text='正在停止…'}})
$open.Add_Click({if($script:target){Start-Process explorer.exe -ArgumentList ('"'+$script:target+'"')}})
$form.Add_FormClosing({
 if($script:proc -and -not $script:proc.HasExited){
  $answer=[Windows.Forms.MessageBox]::Show('复制仍在进行，是否停止并关闭？源文件会保留。','关闭工具','YesNo')
  if($answer -ne 'Yes'){$_.Cancel=$true} else {$script:proc.Kill()}
 }
})
$form.Add_FormClosed({$pathSaveTimer.Stop(); SavePathSettings; $pathSaveTimer.Dispose()})
[Windows.Forms.Application]::Run($form)
$timer.Dispose()
