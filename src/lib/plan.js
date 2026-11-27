'use strict';

/**
 * Decide CÓMO se imprime un trabajo. Puro (sin Electron), probado con node --test.
 *
 * Modos configurables:
 *   auto    (por omisión) se elige según el idioma detectado de la impresora:
 *           star -> 'star', escpos -> 'raw', page -> 'driver'.
 *   driver  página por el driver del sistema.
 *   raw     ESC/POS a la impresora instalada (winspool RAW / CUPS -o raw).
 *   usb     ESC/POS por USB directo (libusb).
 *   net     ESC/POS por red (IP:9100).
 *   star    imagen Star Graphic Mode por RAW (TSP100/TSP143).
 *
 * Mamux puede mandar `html`, `bytes` (ESC/POS) o ambos. Nunca se mandan bytes
 * ESC/POS a una impresora Star.
 */

const { detectLanguage } = require('./detect');

const MODE_IDS = ['auto', 'driver', 'raw', 'usb', 'net', 'star'];

function effectiveMode(mode, language) {
  if (mode !== 'auto') return MODE_IDS.includes(mode) ? mode : 'driver';
  if (language === 'star') return 'star';
  if (language === 'escpos') return 'raw';
  return 'driver';
}

/** Idioma de la impresora configurada (para usb/net es ESC/POS). */
function languageFor(cfg, info) {
  if (cfg.mode === 'usb' || cfg.mode === 'net') return 'escpos';
  if (cfg.mode === 'star') return 'star';
  if (cfg.mode === 'auto' && cfg.language && cfg.language !== 'auto') return cfg.language;
  return detectLanguage({ name: cfg.printer, driver: (info && info.driver) || cfg.printerDriver || '' }).language;
}

/** Modo con el que de verdad se imprimirá (lo que reporta /health). */
function resolveMode(cfg, info) {
  const language = languageFor(cfg, info);
  let mode = effectiveMode(cfg.mode, language);
  // Aunque se haya elegido "RAW" a mano, a una Star nunca se le manda ESC/POS.
  if (mode === 'raw' && language === 'star') mode = 'star';
  return { mode, language };
}

class PlanError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{mode:string, printer?:string, printerDriver?:string, language?:string}} cfg
 * @param {{html?:string|null, bytes?:Buffer|null}} payload
 * @param {{driver?:string}} [info]  datos del sistema de la impresora elegida
 * @returns {{mode:string, language:string, render:'driver'|'raster-star'|'raster-escpos'|'bytes', transport:'driver'|'raw'|'usb'|'net'}}
 */
function planJob(cfg, payload, info) {
  const { mode, language } = resolveMode(cfg, info);
  const hasHtml = typeof payload.html === 'string' && payload.html.trim() !== '';
  const hasBytes = !!(payload.bytes && payload.bytes.length);
  if (!hasHtml && !hasBytes) throw new PlanError('Ticket vacío', 'EMPTY');

  if (mode === 'star') {
    if (!hasHtml) {
      throw new PlanError(
        'Esta impresora es Star TSP100: no entiende ESC/POS. Actualiza Mamux (recarga la página con Ctrl+F5) para que mande el ticket como imagen.',
        'STAR_NEEDS_HTML',
      );
    }
    return { mode, language: 'star', render: 'raster-star', transport: 'raw' };
  }
  if (mode === 'driver') {
    if (hasHtml) return { mode, language, render: 'driver', transport: 'driver' };
    if (language === 'star') {
      throw new PlanError(
        'La impresora es Star: no se le pueden mandar bytes ESC/POS por el driver. Actualiza Mamux o elige el modo Automático.',
        'STAR_NEEDS_HTML',
      );
    }
    // Compatibilidad: Mamux viejo manda solo bytes en este modo (antes iban RAW).
    return { mode, language, render: 'bytes', transport: 'raw' };
  }
  // raw | usb | net: ESC/POS. Se prefieren los bytes de Mamux (texto nítido y rápido).
  return { mode, language: 'escpos', render: hasBytes ? 'bytes' : 'raster-escpos', transport: mode };
}

/** Tamaño de página para el driver: el del driver si no acepta tamaños propios. */
function driverPageSizeMode(cfg, language, thermal) {
  if (!thermal) return 'paper';
  if (cfg.driverPageSize === 'custom' || cfg.driverPageSize === 'printer') return cfg.driverPageSize;
  // auto: los drivers Star solo aceptan sus tamaños ("72mm x Receipt"), no uno propio.
  return language === 'star' ? 'printer' : 'custom';
}

module.exports = { MODE_IDS, effectiveMode, languageFor, resolveMode, planJob, PlanError, driverPageSizeMode };
