'use strict';

/**
 * PowerShell persistente para mandar bytes RAW por winspool (Windows).
 *
 * Antes cada ticket lanzaba powershell.exe y compilaba la clase C# con Add-Type
 * (1.5–3 s por ticket). Aquí PowerShell arranca UNA vez al abrir el agente,
 * compila la clase una vez y recibe los trabajos por stdin: cada ticket tarda
 * lo que tarda el spooler (decenas de ms). Adaptado del agente de Comody.
 *
 * Protocolo (una línea por trabajo):  "<id> <impresora base64 UTF-8> <bytes base64>"
 * Respuesta:                           "MAMUX <id> OK" | "MAMUX <id> <motivo>"
 *
 * Nunca duplica papel: si el trabajo no llegó al proceso, el error lleva
 * `noEnviado` y se usa el script de un solo uso; si llegó y no hubo respuesta,
 * lleva `sent` (sin confirmar: no se reintenta).
 */

const RAW_PRINTER_CS = `
using System;
using System.Runtime.InteropServices;
public class MamuxRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFOW { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOW di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
  public static string SendBytes(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "OPEN_FAILED:" + Marshal.GetLastWin32Error();
    var di = new DOCINFOW(); di.pDocName = "Mamux Ticket"; di.pDataType = "RAW";
    if (StartDocPrinter(h, 1, di) == 0) { ClosePrinter(h); return "STARTDOC_FAILED:" + Marshal.GetLastWin32Error(); }
    if (!StartPagePrinter(h)) { EndDocPrinter(h); ClosePrinter(h); return "STARTPAGE_FAILED:" + Marshal.GetLastWin32Error(); }
    int written;
    bool ok = WritePrinter(h, bytes, bytes.Length, out written);
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    if (!ok) return "WRITE_FAILED:" + Marshal.GetLastWin32Error();
    if (written != bytes.Length) return "PARTIAL_WRITE:" + written + "/" + bytes.Length;
    return "OK";
  }
}
`.trim();

/** Motivo de winspool -> mensaje para el cajero. */
function describeRawError(reason) {
  const r = String(reason || '');
  if (/OPEN_FAILED:1801/.test(r)) return 'La impresora configurada no existe o fue renombrada.';
  if (/OPEN_FAILED/.test(r)) return 'No se pudo abrir la impresora (¿apagada o desconectada?).';
  if (/STARTDOC_FAILED|STARTPAGE_FAILED/.test(r)) return 'Windows rechazó el trabajo de impresión.';
  if (/WRITE_FAILED|PARTIAL_WRITE/.test(r)) return 'Error al enviar el ticket a la impresora.';
  return r.replace(/^PRINT_ERROR:/, '') || 'No se pudo imprimir.';
}

function buildWorkerScript() {
  return `
$ErrorActionPreference = 'Stop'
$signature = @'
${RAW_PRINTER_CS}
'@
Add-Type -TypeDefinition $signature -Language CSharp
[Console]::Out.WriteLine('MAMUX READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  if ($p.Length -lt 3) { continue }
  try {
    $name = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
    $res = [MamuxRawPrinter]::SendBytes($name, [Convert]::FromBase64String($p[2]))
  } catch { $res = 'PRINT_ERROR:' + $_.Exception.Message }
  [Console]::Out.WriteLine('MAMUX ' + $p[0] + ' ' + $res)
  [Console]::Out.Flush()
}
`.trim();
}

/** El script va codificado (UTF-16LE base64): sin problemas de comillas. */
function workerArgs() {
  const enc = Buffer.from(buildWorkerScript(), 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc];
}

const fail = (msg, extra) => Object.assign(new Error(msg), extra);

/**
 * @param {object} deps
 * @param {Function} deps.spawn child_process.spawn
 * @param {{info:Function,warn:Function}} [deps.logger]
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.readyTimeoutMs]
 * @param {number} [deps.maxStartFailures]
 */
function createWinspoolWorker({ spawn, logger, timeoutMs = 20000, readyTimeoutMs = 15000, maxStartFailures = 3 }) {
  const log = logger || { info() {}, warn() {} };
  let proc = null;
  let ready = null;
  let startFailures = 0;
  let nextId = 1;
  let pending = null;
  let queue = Promise.resolve();

  function terminate(reason) {
    const p = proc;
    proc = null;
    ready = null;
    if (p) {
      try { p.kill(); } catch { /* ya terminó */ }
    }
    if (pending) {
      const { reject, timer } = pending;
      pending = null;
      clearTimeout(timer);
      reject(fail(reason, { sent: true, code: 'UNCONFIRMED' }));
    }
  }

  function onLine(line) {
    const m = /^MAMUX (\S+) (.*)$/.exec(line.trim());
    if (!m || !pending || m[1] !== pending.id) return;
    const { resolve, reject, timer } = pending;
    pending = null;
    clearTimeout(timer);
    if (m[2] === 'OK') return resolve();
    reject(fail(describeRawError(m[2]), { code: 'RAW_ERROR' }));
  }

  function start() {
    if (ready) return ready;
    if (startFailures >= maxStartFailures) return Promise.reject(fail('PowerShell persistente desactivado', { noEnviado: true }));
    ready = new Promise((resolve, reject) => {
      let p;
      try {
        p = spawn('powershell.exe', workerArgs(), { windowsHide: true, stdio: 'pipe' });
      } catch (e) {
        startFailures++;
        ready = null;
        return reject(fail(e.message, { noEnviado: true }));
      }
      proc = p;
      let buffer = '';
      let started = false;
      const timer = setTimeout(() => startFail('PowerShell no arrancó a tiempo'), readyTimeoutMs);
      function startFail(msg) {
        if (started) return;
        started = true;
        clearTimeout(timer);
        startFailures++;
        log.warn(`Impresión RAW persistente no disponible: ${msg}`);
        if (proc === p) terminate(msg);
        reject(fail(msg, { noEnviado: true }));
      }
      if (p.stdout.setEncoding) p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).replace(/\r$/, '');
          buffer = buffer.slice(i + 1);
          if (!started && line.trim() === 'MAMUX READY') {
            started = true;
            clearTimeout(timer);
            startFailures = 0;
            log.info('Impresión RAW persistente lista.');
            resolve();
          } else onLine(line);
        }
      });
      if (p.stdin && p.stdin.on) p.stdin.on('error', () => {});
      p.on('error', (e) => (started ? proc === p && terminate(e.message) : startFail(e.message)));
      p.on('exit', () => (started ? proc === p && terminate('PowerShell terminó') : startFail('PowerShell terminó')));
    });
    return ready;
  }

  async function sendNow(buf, printerName) {
    await start();
    if (!proc) throw fail('PowerShell no disponible', { noEnviado: true });
    const id = String(nextId++);
    const name = Buffer.from(String(printerName), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => terminate('La impresora no respondió a tiempo'), timeoutMs);
      pending = { id, resolve, reject, timer };
      proc.stdin.write(`${id} ${name} ${Buffer.from(buf).toString('base64')}\n`);
    });
  }

  /** Un trabajo a la vez (el proceso responde en orden). */
  function send(buf, printerName) {
    const r = queue.then(() => sendNow(buf, printerName));
    queue = r.catch(() => undefined);
    return r;
  }

  return {
    send,
    warm: () => start().catch(() => undefined),
    stop: () => terminate('Agente cerrándose'),
    isReady: () => !!proc,
  };
}

/** Persistente y, si el trabajo no llegó al proceso, el script de un solo uso (nunca ambos). */
function withFallback(worker, oneShot) {
  return async function sendRaw(buf, printerName) {
    try {
      return await worker.send(buf, printerName);
    } catch (e) {
      if (e && e.noEnviado) return oneShot(printerName, buf);
      throw e;
    }
  };
}

module.exports = { RAW_PRINTER_CS, createWinspoolWorker, withFallback, buildWorkerScript, workerArgs, describeRawError };
