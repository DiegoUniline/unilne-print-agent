; Quita el agente anterior (Mamux Print Agent sin ventana, instalado por
; MamuxPrintAgentInstalar.exe) para que no ocupe el puerto 17891.
!macro customInit
  nsExec::Exec 'taskkill /F /IM MamuxPrintAgent.exe'
  nsExec::Exec 'taskkill /F /IM RutAppPrintAgent.exe'
  Delete "$SMSTARTUP\Mamux Print Agent.vbs"
  Delete "$SMSTARTUP\RutApp Print Agent.vbs"
!macroend
