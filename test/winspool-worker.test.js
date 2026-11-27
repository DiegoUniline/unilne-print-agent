'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWinspoolWorker, withFallback, workerArgs } = require('../src/lib/winspool-worker');

function fakeSpawn({ answer = 'OK', ready = true } = {}) {
  const calls = { spawns: 0, lines: [] };
  const spawn = () => {
    calls.spawns++;
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stdin = {
      write(line) {
        calls.lines.push(line);
        const id = line.split(' ')[0];
        if (answer !== null) setImmediate(() => p.stdout.emit('data', `MAMUX ${id} ${answer}\r\n`));
      },
      on() {},
    };
    p.kill = () => setImmediate(() => p.emit('exit'));
    if (ready) setImmediate(() => p.stdout.emit('data', 'MAMUX READY\r\n'));
    else setImmediate(() => p.emit('exit'));
    return p;
  };
  return { spawn, calls };
}

test('un solo PowerShell para varios trabajos', async () => {
  const { spawn, calls } = fakeSpawn();
  const w = createWinspoolWorker({ spawn });
  await w.send(Buffer.from('a'), 'Caja');
  await w.send(Buffer.from('b'), 'Caja ñ');
  assert.equal(calls.spawns, 1);
  const [, nombre, datos] = calls.lines[1].trim().split(' ');
  assert.equal(Buffer.from(nombre, 'base64').toString('utf8'), 'Caja ñ');
  assert.equal(Buffer.from(datos, 'base64').toString(), 'b');
  w.stop();
});

test('error del spooler se traduce', async () => {
  const { spawn } = fakeSpawn({ answer: 'OPEN_FAILED:1801' });
  const w = createWinspoolWorker({ spawn });
  await assert.rejects(w.send(Buffer.from('a'), 'X'), /no existe o fue renombrada/);
  w.stop();
});

test('sin respuesta: error "sent" (no se reintenta ni duplica papel)', async () => {
  const { spawn } = fakeSpawn({ answer: null });
  const w = createWinspoolWorker({ spawn, timeoutMs: 30 });
  let oneShot = 0;
  const send = withFallback(w, async () => { oneShot++; });
  await assert.rejects(send(Buffer.from('a'), 'X'), (e) => e.sent === true);
  assert.equal(oneShot, 0);
  w.stop();
});

test('si PowerShell no arranca se usa el envío de un solo uso', async () => {
  const { spawn } = fakeSpawn({ ready: false });
  const w = createWinspoolWorker({ spawn });
  let args = null;
  const send = withFallback(w, async (printer, data) => { args = [printer, data.toString()]; });
  await send(Buffer.from('z'), 'Caja');
  assert.deepEqual(args, ['Caja', 'z']);
});

test('argumentos de PowerShell codificados', () => {
  const a = workerArgs();
  assert.equal(a[a.length - 2], '-EncodedCommand');
  assert.match(Buffer.from(a[a.length - 1], 'base64').toString('utf16le'), /MAMUX READY/);
});
