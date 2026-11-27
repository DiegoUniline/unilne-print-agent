'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planJob, resolveMode, effectiveMode, driverPageSizeMode } = require('../src/lib/plan');

const STAR = { printer: 'Star TSP100 Cutter (TSP143)', printerDriver: 'Star TSP100 Cutter (TSP143)' };
const EPSON = { printer: 'EPSON TM-T20', printerDriver: 'EPSON TM-T20II Receipt5' };
const HP = { printer: 'HP LaserJet', printerDriver: 'HP LaserJet Pro PCL 6' };
const html = '<p>hola</p>';
const bytes = Buffer.from([0x1b, 0x40, 0x41]);

test('auto: el modo efectivo sale del idioma', () => {
  assert.deepEqual(resolveMode({ mode: 'auto', ...STAR }), { mode: 'star', language: 'star' });
  assert.deepEqual(resolveMode({ mode: 'auto', ...EPSON }), { mode: 'raw', language: 'escpos' });
  assert.deepEqual(resolveMode({ mode: 'auto', ...HP }), { mode: 'driver', language: 'page' });
});

test('auto: el driver del sistema manda sobre lo guardado', () => {
  const r = resolveMode({ mode: 'auto', printer: 'Caja', printerDriver: '' }, { driver: 'Star TSP100 Cutter (TSP143)' });
  assert.equal(r.mode, 'star');
});

test('auto con tipo forzado a mano', () => {
  assert.equal(resolveMode({ mode: 'auto', language: 'escpos', ...HP }).mode, 'raw');
  assert.equal(resolveMode({ mode: 'auto', language: 'page', ...EPSON }).mode, 'driver');
});

test('Star nunca recibe ESC/POS: html+bytes se rasteriza a imagen Star', () => {
  const p = planJob({ mode: 'auto', ...STAR }, { html, bytes });
  assert.equal(p.render, 'raster-star');
  assert.equal(p.transport, 'raw');
});

test('Star con solo bytes se rechaza con mensaje claro', () => {
  assert.throws(() => planJob({ mode: 'auto', ...STAR }, { bytes }), (e) => e.code === 'STAR_NEEDS_HTML');
  assert.throws(() => planJob({ mode: 'star', ...STAR }, { bytes }), (e) => e.code === 'STAR_NEEDS_HTML');
});

test('RAW elegido a mano sobre una Star se corrige a imagen Star', () => {
  const p = planJob({ mode: 'raw', ...STAR }, { html, bytes });
  assert.equal(p.mode, 'star');
  assert.equal(p.render, 'raster-star');
});

test('Driver elegido a mano sobre una Star con solo bytes: rechazo (no se traba)', () => {
  assert.throws(() => planJob({ mode: 'driver', ...STAR }, { bytes }), (e) => e.code === 'STAR_NEEDS_HTML');
  assert.equal(planJob({ mode: 'driver', ...STAR }, { html }).render, 'driver');
});

test('ESC/POS: prefiere los bytes de Mamux; si solo hay html lo rasteriza', () => {
  assert.equal(planJob({ mode: 'auto', ...EPSON }, { html, bytes }).render, 'bytes');
  assert.equal(planJob({ mode: 'auto', ...EPSON }, { html }).render, 'raster-escpos');
  assert.equal(planJob({ mode: 'usb', usbDevice: '0416:5011' }, { html }).transport, 'usb');
  assert.equal(planJob({ mode: 'net', netHost: '10.0.0.5' }, { bytes }).transport, 'net');
});

test('Páginas: html por driver; solo bytes conserva el RAW de siempre', () => {
  assert.equal(planJob({ mode: 'auto', ...HP }, { html, bytes }).render, 'driver');
  const p = planJob({ mode: 'driver', ...HP }, { bytes });
  assert.equal(p.render, 'bytes');
  assert.equal(p.transport, 'raw');
});

test('ticket vacío', () => {
  assert.throws(() => planJob({ mode: 'auto', ...EPSON }, { html: '  ', bytes: Buffer.alloc(0) }), (e) => e.code === 'EMPTY');
});

test('modo desconocido cae a driver', () => {
  assert.equal(effectiveMode('xyz', 'escpos'), 'driver');
});

test('tamaño de página con el driver', () => {
  assert.equal(driverPageSizeMode({ driverPageSize: 'auto' }, 'star', true), 'printer');
  assert.equal(driverPageSizeMode({ driverPageSize: 'auto' }, 'page', true), 'custom');
  assert.equal(driverPageSizeMode({ driverPageSize: 'custom' }, 'star', true), 'custom');
  assert.equal(driverPageSizeMode({ driverPageSize: 'printer' }, 'page', true), 'printer');
  assert.equal(driverPageSizeMode({ driverPageSize: 'auto' }, 'page', false), 'paper');
});
