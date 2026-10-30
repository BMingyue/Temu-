param(
    [switch]$SelfTest,
    [int]$SelfTestDelayMs = 250
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function U([string]$Text) {
    return [System.Text.RegularExpressions.Regex]::Replace(
        $Text,
        '\\u([0-9a-fA-F]{4})',
        { param($Match) [char][Convert]::ToInt32($Match.Groups[1].Value, 16) }
    )
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = U '\u786e\u8ba4\u76ee\u6807\u5e97\u94fa'
$form.Size = New-Object System.Drawing.Size(520, 245)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = U '\u8bf7\u5148\u5728\u4e13\u7528 Chrome \u4e2d\u5207\u6362\u5e97\u94fa'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $false
$title.Location = New-Object System.Drawing.Point(24, 22)
$title.Size = New-Object System.Drawing.Size(460, 36)
$form.Controls.Add($title)

$description = New-Object System.Windows.Forms.Label
$description.Text = U '\u8bf7\u5728\u4e13\u7528\u6d4f\u89c8\u5668\u4e2d\u9009\u597d\u672c\u6b21\u8981\u64cd\u4f5c\u7684\u5e97\u94fa\u3002\n\u70b9\u51fb\u4e0b\u65b9\u786e\u8ba4\u6309\u94ae\u4e4b\u524d\uff0c\u7a0b\u5e8f\u4e0d\u4f1a\u4e0a\u4f20\u6587\u4ef6\uff0c\u4e5f\u4e0d\u4f1a\u63d0\u4ea4\u5408\u89c4\u786e\u8ba4\u3002'
$description.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$description.AutoSize = $false
$description.Location = New-Object System.Drawing.Point(26, 66)
$description.Size = New-Object System.Drawing.Size(460, 64)
$form.Controls.Add($description)

$confirmButton = New-Object System.Windows.Forms.Button
$confirmButton.Text = U '\u786e\u8ba4\u5e97\u94fa\u5e76\u5f00\u59cb'
$confirmButton.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$confirmButton.Location = New-Object System.Drawing.Point(250, 148)
$confirmButton.Size = New-Object System.Drawing.Size(225, 42)
$confirmButton.BackColor = [System.Drawing.Color]::FromArgb(22, 119, 255)
$confirmButton.ForeColor = [System.Drawing.Color]::White
$confirmButton.FlatStyle = 'Flat'
$confirmButton.Add_Click({ $form.Tag = 'confirmed'; $form.Close() })
$form.Controls.Add($confirmButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = U '\u53d6\u6d88\uff0c\u4e0d\u6267\u884c'
$cancelButton.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$cancelButton.Location = New-Object System.Drawing.Point(26, 148)
$cancelButton.Size = New-Object System.Drawing.Size(150, 42)
$cancelButton.Add_Click({ $form.Tag = 'cancelled'; $form.Close() })
$form.Controls.Add($cancelButton)

$form.AcceptButton = $confirmButton
$form.CancelButton = $cancelButton
$form.Add_FormClosing({
    if ($form.Tag -ne 'confirmed') { $form.Tag = 'cancelled' }
})

if ($SelfTest) {
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = [Math]::Max(100, $SelfTestDelayMs)
    $timer.Add_Tick({
        $timer.Stop()
        $form.Tag = 'cancelled'
        $form.Close()
    })
    $timer.Start()
}

[void]$form.ShowDialog()
if ($form.Tag -eq 'confirmed') { exit 0 }
exit 2
