Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

WshShell.CurrentDirectory = "d:\MegaDEV"

If Not fso.FolderExists("d:\MegaDEV\.runs") Then
    fso.CreateFolder("d:\MegaDEV\.runs")
End If
If Not fso.FolderExists("d:\MegaDEV\.runs\services") Then
    fso.CreateFolder("d:\MegaDEV\.runs\services")
End If

' 1. Start BioCore FastAPI Backend with log output to .runs/services/backend.log
WshShell.Run "cmd.exe /c """"""d:\MegaDEV\tools\service\start-backend.cmd"""" > """"d:\MegaDEV\.runs\services\backend.log"""" 2>&1""", 0, False

' 2. Start MegaDEV Telegram Gateway with log output to .runs/services/gateway.log
WshShell.Run "cmd.exe /c """"""d:\MegaDEV\tools\service\start-gateway.cmd"""" > """"d:\MegaDEV\.runs\services\gateway.log"""" 2>&1""", 0, False
