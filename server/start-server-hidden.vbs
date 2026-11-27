' Runs start-server.cmd with no console window. Used by the "TokenScope Central
' Server" scheduled task: a standard (non-admin) user can only register an
' Interactive-logon task, and those show a console for a plain .cmd - this
' wrapper launches it hidden (window style 0) and returns immediately.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.CurrentDirectory = here
shell.Run """" & here & "start-server.cmd""", 0, False
