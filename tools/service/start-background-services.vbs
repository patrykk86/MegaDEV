Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
toolsDir = fso.GetParentFolderName(scriptDir)
rootDir = fso.GetParentFolderName(toolsDir)

WshShell.CurrentDirectory = rootDir

runsDir = fso.BuildPath(rootDir, ".runs")
servicesDir = fso.BuildPath(runsDir, "services")

If Not fso.FolderExists(runsDir) Then
    fso.CreateFolder(runsDir)
End If
If Not fso.FolderExists(servicesDir) Then
    fso.CreateFolder(servicesDir)
End If

backendCmd = fso.BuildPath(scriptDir, "start-backend.cmd")
backendLog = fso.BuildPath(servicesDir, "backend.log")

' 1. Start BioCore FastAPI Backend with log output to .runs/services/backend.log
WshShell.Run "cmd.exe /c """"" & backendCmd & """ > """ & backendLog & """ 2>&1""", 0, False
