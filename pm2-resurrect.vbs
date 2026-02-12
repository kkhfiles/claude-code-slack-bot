Set WshShell = CreateObject("WScript.Shell")
Dim pm2Path
pm2Path = WshShell.ExpandEnvironmentStrings("%APPDATA%") & "\npm\pm2.cmd"
WshShell.Run "cmd /c """ & pm2Path & """ resurrect", 0, False
