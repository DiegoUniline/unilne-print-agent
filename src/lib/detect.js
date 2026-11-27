'use strict';

/**
 * Detección del "idioma" de una impresora por su nombre y su driver
 * (Get-Printer en Windows, printer-make-and-model en macOS/CUPS).
 *
 *   star   Star TSP100/TSP143 (futurePRNT) y familia: solo entienden imagen en
 *          "Star Graphic Mode". Mandarles ESC/POS las traba o imprime basura.
 *   escpos Térmicas ESC/POS (Epson TM, POS-58/80, Xprinter, "Generic / Text
 *          Only", etc.): reciben los bytes del ticket tal cual (RAW).
 *   page   Todo lo demás (láser, inyección, PDF, desconocida): se imprime la
 *          página (HTML) con el driver del sistema.
 *
 * Puro (sin Electron): se prueba con `node --test`.
 */

// Primero Star: su driver dice "Receipt" y no debe caer en ESC/POS.
const STAR = [
  /\bstar\b/i,
  /\btsp\s*-?\s*1\d\d/i, // TSP100, TSP143, TSP143IIIU…
  /\btsp\s*-?\s*(6[05]\d|7\d\d|8\d\d)/i, // TSP650, TSP700II, TSP800II (Star Graphic Mode)
  /future\s*prnt/i,
  /\bmc-?print/i,
  /\bstr_t-\d+/i, // nombre de modelo CUPS de Star (p. ej. "STR_T-001")
];

// Destinos que claramente imprimen páginas (nunca ESC/POS).
const PAGE_STRONG = [
  /\bpdf\b/i,
  /\bxps\b/i,
  /onenote/i,
  /\bfax\b/i,
  /laserjet|deskjet|officejet|envy|inkjet|ecotank|pixma|imageclass|imagerunner/i,
  /\b(brother|canon|lexmark|ricoh|kyocera|xerox|konica|sharp|toshiba e-studio)\b/i,
];

const ESCPOS = [
  /epson\s*tm|\btm-?\s*[tmhlpu]\s*\d/i,
  /\bpos\s*-?\s*(58|76|80)\b|\bpos[-\s]?printer\b|\bpos\b/i,
  /x\s*printer|\bxp-?\s*\d/i,
  /generic\s*\/?\s*text\s*only|\btext\s*only\b/i,
  /thermal|t[ée]rmica|receipt|recibo|ticket/i,
  /\b(58|80)\s*mm\b/i,
  /rongta|\brp\s*-?\d{2,3}\b|bixolon|\bsrp-?\d|citizen|\bct-?s\d|hprt|sewoo|gprinter|zjiang|3nstar|\bec\s*line|munbyn|hoin|goojprt|sunmi|\bsat\s*\d/i,
];

function test(list, text) {
  return list.find((re) => re.test(text)) || null;
}

/**
 * @param {{name?: string, driver?: string}} printer
 * @returns {{language: 'star'|'escpos'|'page', reason: string}}
 */
function detectLanguage(printer = {}) {
  const name = String(printer.name || '');
  const driver = String(printer.driver || '');
  const text = `${driver} ${name}`.trim();
  if (!text) return { language: 'page', reason: 'sin datos' };
  let re = test(STAR, text);
  if (re) return { language: 'star', reason: `Star (${re.source})` };
  re = test(PAGE_STRONG, text);
  if (re) return { language: 'page', reason: 'impresora de páginas' };
  re = test(ESCPOS, text);
  if (re) return { language: 'escpos', reason: 'térmica ESC/POS' };
  return { language: 'page', reason: 'desconocida: se usa el driver' };
}

const LANGUAGE_LABEL = {
  star: 'Star (imagen Star, sin ESC/POS)',
  escpos: 'Térmica ESC/POS',
  page: 'Impresora de páginas (driver)',
};

module.exports = { detectLanguage, LANGUAGE_LABEL };
