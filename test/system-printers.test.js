'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseList, driverFromElectron, buildListCommand } = require('../src/lib/system-printers');

test('Get-Printer con una sola impresora (objeto, no arreglo)', () => {
  const r = parseList('{"name":"Star TSP100 Cutter (TSP143)","driver":"Star TSP100 Cutter (TSP143)","port":"USB001"}');
  assert.deepEqual(r, [{ name: 'Star TSP100 Cutter (TSP143)', driver: 'Star TSP100 Cutter (TSP143)', port: 'USB001' }]);
});

test('Get-Printer con varias y basura', () => {
  assert.equal(parseList('[{"name":"A","driver":null},{"name":""}]').length, 1);
  assert.deepEqual(parseList('no json'), []);
  assert.deepEqual(parseList(''), []);
});

test('modelo desde Electron (CUPS y Windows)', () => {
  assert.equal(driverFromElectron({ options: { 'printer-make-and-model': 'Star TSP143 (STR_T-001)' } }), 'Star TSP143 (STR_T-001)');
  assert.equal(driverFromElectron({ options: { system_driverinfo: 'EPSON TM-T20II Receipt5;6.0;x' } }), 'EPSON TM-T20II Receipt5');
  assert.equal(driverFromElectron({}), '');
});

test('el comando usa Get-Printer con respaldo WMI', () => {
  const c = buildListCommand();
  assert.match(c, /Get-Printer/);
  assert.match(c, /Win32_Printer/);
});
