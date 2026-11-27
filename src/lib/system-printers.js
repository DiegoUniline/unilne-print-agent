'use strict';

/**
 * Lista de impresoras con su DRIVER (para detectar el idioma).
 *   Windows: Get-Printer (respaldo WMI) en una sola llamada a PowerShell.
 *   macOS/Linux: lpstat -l -p (línea "Description"/"Make and Model") + lo que
 *   ya da Electron (`printer-make-and-model`).
 * Las funciones de armado/lectura son puras (probadas con node --test).
 */

function buildListCommand() {
  return [
    "$ErrorActionPreference='Stop';",
    'try {',
    "  $p = Get-Printer | Select-Object Name,DriverName,PortName;",
    '} catch {',
    "  $p = Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName;",
    '}',
    '$out = @($p) | ForEach-Object { [pscustomobject]@{ name=$_.Name; driver=$_.DriverName; port=$_.PortName } };',
    'ConvertTo-Json -InputObject @($out) -Compress',
  ].join(' ');
}

/** ConvertTo-Json devuelve objeto (no arreglo) cuando hay una sola impresora. */
function parseList(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : [data];
  return arr
    .filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .map((x) => ({ name: String(x.name).trim(), driver: x.driver ? String(x.driver) : '', port: x.port ? String(x.port) : '' }));
}

/** Modelo que Electron/Chromium reporta en options (CUPS y, en Windows, system_driverinfo). */
function driverFromElectron(p) {
  const o = (p && p.options) || {};
  const v = o['printer-make-and-model'] || o.system_driverinfo || '';
  return String(v).split(';')[0].trim();
}

module.exports = { buildListCommand, parseList, driverFromElectron };
