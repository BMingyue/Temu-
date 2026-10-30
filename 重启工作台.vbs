Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
python = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python312\pythonw.exe"
If MsgBox("Restart the local workbench? Save edits and stop running tasks first.", 36, "Restart workbench") = 6 Then
  shell.Run Chr(34) & python & Chr(34) & " " & Chr(34) & folder & "\restart_workbench.py" & Chr(34), 0, False
End If
