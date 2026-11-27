'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEscPos, buildStarRaster, rowsToRaster, bitmapToRaster } = require('../src/escpos');

function bgra(width, height, negro) {
  const data = Buffer.alloc(width * height * 4, 0xff);
  for (const [x, y] of negro) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return { width, height, data };
}

test('bitmapToRaster: umbral, margen y recorte de blancos al final', () => {
  const img = bgra(16, 4, [[0, 0], [9, 1]]);
  const r = bitmapToRaster(img, 170, 8);
  assert.equal(r.widthBytes, 3);
  assert.equal(r.height, 2); // los 2 renglones blancos del final se recortan
  assert.equal(r.data[1], 0x80); // x=0 movido 8 puntos -> byte 1, bit alto
  assert.equal(r.data[3 + 2], 0x40); // x=9+8=17 -> byte 2, bit 1
});

test('rowsToRaster con fila totalmente blanca da altura 0', () => {
  const r = rowsToRaster([Buffer.alloc(8 * 4, 0xff)], 8, 170);
  assert.equal(r.height, 0);
});

test('buildEscPos: ESC @, GS v 0 con ancho/alto y corte', () => {
  const raster = { widthBytes: 2, height: 3, data: Buffer.from([1, 2, 3, 4, 5, 6]) };
  const b = buildEscPos(raster, { cut: true, feedLines: 4 });
  assert.deepEqual([...b.subarray(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...b.subarray(2, 10)], [0x1d, 0x76, 0x30, 0x00, 2, 0, 3, 0]);
  assert.deepEqual([...b.subarray(10, 16)], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...b.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
});

test('buildStarRaster: secuencia Star Graphic Mode, sin GS v 0', () => {
  const raster = { widthBytes: 2, height: 3, data: Buffer.from([0xff, 0, 0, 0, 0x01, 0x80]) };
  const b = buildStarRaster(raster, { cut: true });
  const s = b.toString('latin1');
  assert.ok(s.startsWith('\x1b@\x1b*rR\x1b*rA\x1b*rP0\x00'));
  assert.ok(s.includes('\x1b*rF13\x00'));
  assert.ok(s.includes('b\x01\x00\xff')); // renglón 1: sin ceros al final
  assert.ok(s.includes('\x1b*rY1\x00')); // renglón 2 en blanco
  assert.ok(s.includes('b\x02\x00\x01\x80'));
  assert.ok(s.endsWith('\x04\x1b*rB'));
  assert.equal(s.indexOf('\x1dv0'), -1);
});

test('buildStarRaster limita a 72 bytes (576 puntos)', () => {
  const raster = { widthBytes: 80, height: 1, data: Buffer.alloc(80, 0xff) };
  const s = buildStarRaster(raster, {}).toString('latin1');
  assert.ok(s.includes('b\x48\x00'));
});
