# Mamux Print Agent

Agente local de impresión directa de tickets para Mamux (Windows y macOS).

Descarga: https://github.com/DiegoUniline/unilne-print-agent/releases/latest/download/Mamux-Print-Agent-Setup.exe
Mac (Apple Silicon): https://github.com/DiegoUniline/unilne-print-agent/releases/latest/download/Mamux-Print-Agent.dmg

Escucha en `http://127.0.0.1:17891` (mismo puerto del agente anterior).

| Tipo de conexión | Uso |
|---|---|
| **Automático** (por omisión) | Reconoce la impresora por su driver: Star TSP100/TSP143 → imagen Star por RAW; térmicas ESC/POS (Epson TM, POS-58/80, Xprinter, "Generic / Text Only"…) → ESC/POS RAW; cualquier otra → página por el driver |
| Star TSP100 (imagen Star) | Fuerza el lenguaje Star (sin ESC/POS) |
| ESC/POS a impresora instalada (RAW) | Manda el ticket de Mamux tal cual a la impresora del sistema |
| ESC/POS USB directo | Térmicas USB sin driver (WinUSB/libusbK) |
| ESC/POS por red (IP) | Térmicas de red/WiFi, puerto 9100 |
| Driver de Windows | Impresión HTML con el driver |

API: `GET /health`, `GET /printers`, `POST /set-printer {name}`, `POST /print {html?, dataBase64?, name}`, `GET /status`, `POST /test`.

Desde la 2.1 (`/health` → `api: 2`) Mamux manda `html` y `dataBase64` juntos y el
agente decide: a una Star nunca le manda ESC/POS (rasteriza el html); a una
ESC/POS le manda los bytes; a una impresora de páginas, el html por el driver.
`/health.mode` es el modo efectivo (`star`/`raw`/`driver`/…) y
`configuredMode` el elegido en la ventana (`auto`).

Velocidad: PowerShell persistente para winspool (sin compilar C# por ticket),
ventana de render reutilizada y sin archivos temporales. Pruebas: `npm test`.

Al pasar de 2.0.x a 2.1 una configuración en "Driver de Windows" cambia sola a
"Automático" (los demás modos se respetan).

Al instalar se cierra y quita el agente anterior (MamuxPrintAgent.exe) para liberar el puerto.
