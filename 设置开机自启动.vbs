Option Explicit
Dim shell, fso, folder, link, target
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
target = folder & "\" & ChrW(&H542F) & ChrW(&H52A8) & ChrW(&H5DE5) & ChrW(&H4F5C) & ChrW(&H53F0) & ".vbs"
If Not fso.FileExists(target) Then
  MsgBox "Launcher not found: " & target, 16, "Workbench"
  WScript.Quit 1
End If
Set link = shell.CreateShortcut(shell.SpecialFolders("Startup") & "\TemuWorkbench.lnk")
link.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
link.Arguments = Chr(34) & target & Chr(34)
link.WorkingDirectory = folder
link.Description = "Start local Temu workbench after Windows sign-in"
link.WindowStyle = 7
link.Save
MsgBox "Auto-start enabled. The workbench will open after Windows sign-in.", 64, "Workbench"
