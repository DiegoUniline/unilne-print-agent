# Mamux Print Agent

Agente local de impresión directa de tickets para Mamux (Windows y macOS).

Descarga: https://github.com/DiegoUniline/unilne-print-agent/releases/latest/download/Mamux-Print-Agent-Setup.exe
Mac (Apple Silicon): https://github.com/DiegoUniline/unilne-print-agent/releases/latest/download/Mamux-Print-Agent.dmg

Escucha en `http://127.0.0.1:17891` (mismo puerto del agente anterior).

| Tipo de conexión | Uso |
|---|---|
| ESC/POS a impresora instalada (RAW) | Recomendado: manda el ticket de Mamux tal cual a la impresora del sistema |
| ESC/POS USB directo | Térmicas USB sin driver (WinUSB/libusbK) |
| ESC/POS por red (IP) | Térmicas de red/WiFi, puerto 9100 |
| Driver de Windows | Impresión HTML con el driver |

API: `GET /health`, `GET /printers`, `POST /set-printer {name}`, `POST /print {dataBase64, name}` o `{html}`, `GET /status`, `POST /test`.

Al instalar se cierra y quita el agente anterior (MamuxPrintAgent.exe) para liberar el puerto.
