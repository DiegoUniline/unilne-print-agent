'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage } = require('../src/lib/detect');

const casos = [
  // Star
  [{ name: 'Star TSP100 Cutter (TSP143)', driver: 'Star TSP100 Cutter (TSP143)' }, 'star'],
  [{ name: 'Caja 1', driver: 'Star TSP100 Cutter (TSP143)' }, 'star'],
  [{ name: 'TSP143IIIU', driver: '' }, 'star'],
  [{ name: 'Impresora tickets', driver: 'Star futurePRNT TSP100' }, 'star'],
  [{ name: 'Star TSP143 (STR_T-001)', driver: '' }, 'star'],
  [{ name: 'TSP650II', driver: 'Star TSP650II' }, 'star'],
  // ESC/POS
  [{ name: 'EPSON TM-T20II Receipt', driver: 'EPSON TM-T20II Receipt5' }, 'escpos'],
  [{ name: 'POS-80', driver: 'POS-80C' }, 'escpos'],
  [{ name: 'POS58 Printer', driver: 'POS58 Printer Driver' }, 'escpos'],
  [{ name: 'XP-80C', driver: 'XP-80' }, 'escpos'],
  [{ name: 'Xprinter XP-58', driver: '' }, 'escpos'],
  [{ name: 'Tickets', driver: 'Generic / Text Only' }, 'escpos'],
  [{ name: 'Thermal Receipt Printer', driver: '' }, 'escpos'],
  [{ name: '80mm Series Printer', driver: '80mm Series Printer' }, 'escpos'],
  [{ name: 'BIXOLON SRP-350III', driver: 'BIXOLON SRP-350III' }, 'escpos'],
  [{ name: 'EC Line 58', driver: '3nStar RPT004' }, 'escpos'],
  // Páginas
  [{ name: 'Microsoft Print to PDF', driver: 'Microsoft Print To PDF' }, 'page'],
  [{ name: 'HP LaserJet Pro M404', driver: 'HP LaserJet Pro M404-M405 PCL 6' }, 'page'],
  [{ name: 'EPSON L3150 Series', driver: 'EPSON L3150 Series' }, 'page'],
  [{ name: 'Brother HL-L2350DW', driver: 'Brother HL-L2350D series' }, 'page'],
  [{ name: 'Fax', driver: 'Microsoft Shared Fax Driver' }, 'page'],
  [{ name: 'Oficina', driver: 'Canon Generic Plus UFR II' }, 'page'],
  [{ name: '', driver: '' }, 'page'],
  [{ name: 'Algo raro', driver: 'Driver X' }, 'page'],
];

for (const [printer, esperado] of casos) {
  test(`${printer.name || '(vacía)'} / ${printer.driver || '-'} -> ${esperado}`, () => {
    assert.equal(detectLanguage(printer).language, esperado);
  });
}
