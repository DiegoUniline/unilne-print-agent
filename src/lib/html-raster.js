'use strict';

/**
 * HTML -> pixeles con UNA ventana offscreen reutilizada (adaptado del agente de
 * Comody). Crear y destruir una ventana por ticket era lo lento.
 *
 * - `javascript: false`: ningún <script> del ticket corre en el agente. La
 *   medición y la captura van por el protocolo de DevTools
 *   (Page.getLayoutMetrics / Page.captureScreenshot), que no necesita JS.
 * - Se carga como data: URL (sin archivo temporal).
 * - Captura por tramos para no topar con el límite de textura de la GPU en
 *   tickets largos (cortes de caja).
 */

const SEGMENT_DOTS = 2048;
const MAX_DATA_URL = 1900 * 1024; // Chromium limita las URL a 2 MB

function renderError(message, code) {
  return Object.assign(new Error(message), { code });
}

function htmlDataUrl(html) {
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  if (url.length > MAX_DATA_URL) throw renderError('El ticket es demasiado grande (reduce el logo)', 'TOO_LARGE');
  return url;
}

async function capture(dbg, nativeImage, cssWidth, widthDots, settleMs) {
  await dbg.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
  await new Promise((r) => setTimeout(r, settleMs));
  const m = await dbg.sendCommand('Page.getLayoutMetrics');
  const size = m.cssContentSize || m.contentSize;
  const width = Math.max(cssWidth, Math.ceil(size.width));
  const height = Math.max(1, Math.ceil(size.height));
  const scale = widthDots / width;
  const segCss = Math.max(1, Math.floor(SEGMENT_DOTS / scale));
  const parts = [];
  let total = 0;
  for (let y = 0; y < height; y += segCss) {
    const h = Math.min(segCss, height - y);
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y, width, height: h, scale },
    });
    let img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    const s = img.getSize();
    const rows = Math.max(1, Math.round(h * scale));
    if (s.width !== widthDots || s.height !== rows) img = img.resize({ width: widthDots, height: rows, quality: 'best' });
    parts.push(img.toBitmap());
    total += rows;
  }
  // toBitmap() entrega BGRA (Windows/Linux/macOS little-endian).
  return { width: widthDots, height: total, data: Buffer.concat(parts) };
}

/**
 * @param {{BrowserWindow:any, nativeImage:any}} electron
 * @returns {{render:(html:string, opts:{cssWidth:number, widthDots:number, timeoutMs?:number, settleMs?:number})=>Promise<{width:number,height:number,data:Buffer}>, warm:()=>void, dispose:()=>void}}
 */
function createHtmlRenderer({ BrowserWindow, nativeImage }) {
  let win = null;
  let queue = Promise.resolve();

  function dispose() {
    const w = win;
    win = null;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
  }

  function getWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 302,
      height: 600,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, javascript: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', dispose);
    win.webContents.debugger.attach('1.3');
    return win;
  }

  async function renderOne(html, opts) {
    const w = getWindow();
    w.setContentSize(Math.max(50, Math.round(opts.cssWidth)), 600);
    try {
      await w.loadURL(htmlDataUrl(html));
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') throw e;
      throw renderError(`No se pudo preparar el ticket: ${(e && (e.code || e.message)) || 'error'}`, 'RENDER_FAILED');
    }
    return capture(w.webContents.debugger, nativeImage, opts.cssWidth, opts.widthDots, opts.settleMs ?? 100);
  }

  function render(html, opts) {
    const run = queue.then(async () => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          dispose();
          reject(renderError('Tiempo de espera al preparar el ticket', 'RENDER_TIMEOUT'));
        }, opts.timeoutMs || 15000);
      });
      try {
        return await Promise.race([renderOne(html, opts), timeout]);
      } catch (e) {
        if (e && e.code !== 'RENDER_TIMEOUT' && e.code !== 'TOO_LARGE') dispose();
        throw e;
      } finally {
        clearTimeout(timer);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Crea la ventana y el proceso de render antes del primer ticket. */
  function warm() {
    try {
      const w = getWindow();
      w.loadURL('data:text/html;charset=utf-8,<html><body></body></html>').catch(() => {});
    } catch { /* se reintenta en el primer ticket */ }
  }

  return { render, warm, dispose };
}

module.exports = { createHtmlRenderer, htmlDataUrl, MAX_DATA_URL };
