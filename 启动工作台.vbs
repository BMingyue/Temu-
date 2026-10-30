Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
python = folder & "\runtime\python\pythonw.exe"
If Not fso.FileExists(python) Then
  python = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\pythonw.exe"
End If
If Not fso.FileExists(python) Then
  MsgBox "Workbench Python runtime not found: " & python, 16, "Workbench startup"
  WScript.Quit 1
End If
shell.Run Chr(34) & python & Chr(34) & " " & Chr(34) & folder & "\launcher.py" & Chr(34), 0, False
