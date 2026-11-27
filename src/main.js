const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const escpos = require('./escpos');
const { detectLanguage, LANGUAGE_LABEL } = require('./lib/detect');
const { planJob, resolveMode, PlanError, driverPageSizeMode } = require('./lib/plan');
const { createWinspoolWorker, withFallback } = require('./lib/winspool-worker');
const { createHtmlRenderer, htmlDataUrl } = require('./lib/html-raster');
const systemPrinters = require('./lib/system-printers');

// Mismo puerto que el agente anterior: Mamux ya lo busca aquí.
const DEFAULT_PORT = 17891;
const PX_PER_MM = 96 / 25.4;
const MAX_BODY = 15 * 1024 * 1024;
const DOTS_PER_MM = 8;
const STAR_MAX_DOTS = 576;
// Ningún trabajo detiene la cola más de esto (la impresora no respondió).
const JOB_TIMEOUT_MS = 25000;
// Contrato de /health y /print: 2 = acepta html + bytes juntos y decide el agente.
const API_VERSION = 2;
const CONFIG_VERSION = 2;

const MODES = {
  auto: 'Automático (recomendado)',
  driver: 'Driver de Windows',
  raw: 'ESC/POS a impresora instalada (RAW)',
  usb: 'ESC/POS USB directo',
  net: 'ESC/POS por red (IP)',
  star: 'Star TSP100 (imagen Star, sin driver)',
};

const LANGUAGES = {
  auto: 'Detectar por el nombre del driver',
  star: LANGUAGE_LABEL.star,
  escpos: LANGUAGE_LABEL.escpos,
  page: LANGUAGE_LABEL.page,
};

const DRIVER_PAGE_SIZES = {
  auto: 'Automático',
  custom: 'Largo exacto del ticket',
  printer: 'Tamaño configurado en el driver',
};

const PAPERS = {
  '58': { label: 'Térmica 58 mm', widthMm: 58, printableMm: 48 },
  '80': { label: 'Térmica 80 mm', widthMm: 80, printableMm: 72 },
  custom: { label: 'Térmica personalizada' },
  Letter: { label: 'Carta', pageSize: 'Letter' },
  A4: { label: 'A4', pageSize: 'A4' },
  driver: { label: 'Tamaño del driver', pageSize: null },
};

const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  port: DEFAULT_PORT,
  mode: 'auto',
  language: 'auto',
  driverPageSize: 'auto',
  printer: '',
  printerDriver: '',
  usbDevice: '',
  netHost: '',
  netPort: 9100,
  cut: true,
  drawer: false,
  threshold: 170,
  paper: '80',
  customWidthMm: 80,
  printableMm: 72,
  offsetMm: 0,
  scale: 100,
  copies: 1,
  forceBlack: true,
  autoStart: true,
};

let config = { ...DEFAULT_CONFIG };
let tray = null;
let settingsWin = null;
let server = null;
let serverError = '';
let queue = Promise.resolve();
const jobs = [];
/** nombre -> { driver, port } del sistema (Get-Printer / Electron). */
const printerInfo = new Map();

const configPath = () => path.join(app.getPath('userData'), 'config.json');

const logger = {
  info: (m) => console.log(`[agente] ${m}`),
  warn: (m) => console.warn(`[agente] ${m}`),
};

/* ───────────── Configuración ───────────── */

/** Lleva una configuración guardada por una versión anterior al esquema actual. */
function migrate(stored) {
  const out = { ...stored };
  if (!(Number(stored.configVersion) >= CONFIG_VERSION)) {
    // 2.1: "Driver de Windows" era la opción "por si acaso" y es justo la que
    // falla con Star TSP100; Automático elige driver solo cuando hace falta.
    if (!stored.mode || stored.mode === 'driver') out.mode = 'auto';
    out.configVersion = CONFIG_VERSION;
  }
  return out;
}

function loadConfig() {
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    stored = null;
  }
  config = { ...DEFAULT_CONFIG, ...(stored ? sanitize(migrate(stored)) : {}) };
  if (stored && Number(stored.configVersion) !== CONFIG_VERSION) writeConfig();
}

function writeConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (err) {
    logger.warn(`No se pudo guardar la configuración: ${err.message}`);
  }
}

function saveConfig(next) {
  const prevPort = config.port;
  const prevPrinter = config.printer;
  config = { ...config, ...sanitize(next), configVersion: CONFIG_VERSION };
  const info = printerInfo.get(config.printer);
  if (info && info.driver) config.printerDriver = info.driver;
  else if (config.printer !== prevPrinter) config.printerDriver = '';
  writeConfig();
  applyAutoStart();
  if (prevPort !== config.port) startServer();
  return config;
}

function sanitize(c) {
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const out = {};
  if ('configVersion' in c) out.configVersion = Math.round(num(c.configVersion, 0, 99, 0));
  if ('mode' in c) out.mode = MODES[c.mode] ? c.mode : 'auto';
  if ('language' in c) out.language = LANGUAGES[c.language] ? c.language : 'auto';
  if ('driverPageSize' in c) out.driverPageSize = DRIVER_PAGE_SIZES[c.driverPageSize] ? c.driverPageSize : 'auto';
  if ('printer' in c) out.printer = String(c.printer || '');
  if ('printerDriver' in c) out.printerDriver = String(c.printerDriver || '');
  if ('usbDevice' in c) out.usbDevice = String(c.usbDevice || '');
  if ('netHost' in c) out.netHost = String(c.netHost || '').trim();
  if ('netPort' in c) out.netPort = Math.round(num(c.netPort, 1, 65535, 9100));
  if ('cut' in c) out.cut = !!c.cut;
  if ('drawer' in c) out.drawer = !!c.drawer;
  if ('threshold' in c) out.threshold = Math.round(num(c.threshold, 50, 250, 170));
  if ('paper' in c) out.paper = PAPERS[c.paper] ? c.paper : '80';
  if ('customWidthMm' in c) out.customWidthMm = num(c.customWidthMm, 30, 120, 80);
  if ('printableMm' in c) out.printableMm = num(c.printableMm, 20, 120, 72);
  if ('offsetMm' in c) out.offsetMm = num(c.offsetMm, -10, 20, 0);
  if ('scale' in c) out.scale = Math.round(num(c.scale, 30, 200, 100));
  if ('copies' in c) out.copies = Math.round(num(c.copies, 1, 10, 1));
  if ('forceBlack' in c) out.forceBlack = !!c.forceBlack;
  if ('autoStart' in c) out.autoStart = !!c.autoStart;
  if ('port' in c) out.port = Math.round(num(c.port, 1024, 65535, DEFAULT_PORT));
  return out;
}

function applyAutoStart() {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
}

/* ───────────── Impresoras del sistema (driver -> idioma) ───────────── */

/** Datos del sistema de una impresora; si aún no se listó, lo guardado en config. */
function infoFor(cfg) {
  const i = printerInfo.get(cfg.printer);
  if (i && i.driver) return i;
  return { driver: cfg.printer === config.printer ? config.printerDriver : '' };
}

/** Get-Printer (Windows): una sola llamada, al abrir el agente y al listar. */
function refreshSystemPrinters() {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', systemPrinters.buildListCommand()],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) logger.warn(`No se pudo leer Get-Printer: ${err.message.split('\n')[0]}`);
        for (const p of systemPrinters.parseList(stdout)) {
          printerInfo.set(p.name, { ...(printerInfo.get(p.name) || {}), driver: p.driver, port: p.port });
        }
        rememberDriver();
        resolve();
      },
    );
  });
}

/** Guarda el driver de la impresora elegida: el modo Automático funciona desde el arranque. */
function rememberDriver() {
  const i = printerInfo.get(config.printer);
  if (i && i.driver && i.driver !== config.printerDriver) {
    config.printerDriver = i.driver;
    writeConfig();
  }
}

/* ───────────── Transportes ───────────── */

const winspoolWorker = process.platform === 'win32' ? createWinspoolWorker({ spawn, logger }) : null;
const sendRawWindows = winspoolWorker ? withFallback(winspoolWorker, escpos.sendRawWindows) : null;

function sendRawSystem(printer, data) {
  if (process.platform === 'win32') return sendRawWindows(data, printer);
  return escpos.sendRawCups(printer, data);
}

async function sendTo(transport, cfg, data) {
  if (transport === 'usb') {
    if (!cfg.usbDevice) throw new Error('Selecciona la impresora USB en Mamux Print Agent');
    return escpos.sendUsb(cfg.usbDevice, data);
  }
  if (transport === 'net') {
    if (!cfg.netHost) throw new Error('Escribe la IP de la impresora en Mamux Print Agent');
    return escpos.sendNet(cfg.netHost, cfg.netPort, data);
  }
  if (!cfg.printer) throw new Error('Elige la impresora en Mamux Print Agent');
  return sendRawSystem(cfg.printer, data);
}

/* ───────────── Página (HTML) ───────────── */

function paperSpec(cfg) {
  if (cfg.paper === '58' || cfg.paper === '80') {
    const p = PAPERS[cfg.paper];
    return { thermal: true, widthMm: p.widthMm, printableMm: Math.min(cfg.printableMm || p.printableMm, p.widthMm) };
  }
  if (cfg.paper === 'custom') {
    return { thermal: true, widthMm: cfg.customWidthMm, printableMm: Math.min(cfg.printableMm, cfg.customWidthMm) };
  }
  return { thermal: false, pageSize: PAPERS[cfg.paper]?.pageSize ?? null };
}

function injectCss(html, css) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"><style id="__mamux_print">${css}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${tag}</head><body>${html}</body></html>`;
}

function buildCss(spec, cfg) {
  let css = '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}';
  if (cfg.forceBlack) css += '*{color:#000 !important}';
  if (spec.thermal) {
    // Sin `size` en @page: el tamaño lo decide la opción pageSize de la impresión.
    css += `@page{margin:0}
html{margin:0 !important;padding:0 !important;width:${spec.widthMm}mm !important}
body{box-sizing:border-box;width:${spec.printableMm}mm !important;max-width:${spec.printableMm}mm !important;margin:0 0 0 ${cfg.offsetMm}mm !important;word-wrap:break-word}
html{overflow-x:hidden !important}::-webkit-scrollbar{display:none}
img{max-width:100%}`;
  }
  return css;
}

/** Ventana oculta REUTILIZADA para imprimir con el driver (crear una por ticket era lento). */
let driverWin = null;
function disposeDriverWindow() {
  const w = driverWin;
  driverWin = null;
  try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
}
function getDriverWindow() {
  if (driverWin && !driverWin.isDestroyed()) return driverWin;
  driverWin = new BrowserWindow({
    show: false,
    width: 302,
    height: 600,
    useContentSize: true,
    // Pinta aunque esté oculta y sin frenar temporizadores: una ventana oculta
    // "dormida" es una de las causas de páginas en blanco al imprimir.
    paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  driverWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  driverWin.webContents.on('will-navigate', (e) => e.preventDefault());
  driverWin.webContents.on('render-process-gone', disposeDriverWindow);
  return driverWin;
}

/** Carga el HTML como data: URL; si no cabe (logo enorme), por archivo temporal. */
async function loadHtml(win, html) {
  try {
    await win.loadURL(htmlDataUrl(html));
    return () => {};
  } catch (err) {
    if (err.code !== 'TOO_LARGE') throw err;
    const tmp = path.join(os.tmpdir(), `mamux-print-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    await win.loadFile(tmp);
    return () => fs.rm(tmp, { force: true }, () => {});
  }
}

/** Espera fuentes e imágenes; devuelve la altura del contenido en px CSS. */
const WAIT_AND_MEASURE = `(() => {
  const imgs = Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); }));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : null;
  return Promise.race([Promise.all([fonts, ...imgs]), new Promise((r) => setTimeout(r, 1500))])
    .then(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)));
})()`;

async function printHtmlDriver(html, cfg, language) {
  const spec = paperSpec(cfg);
  const win = getDriverWindow();
  const widthPx = Math.ceil((spec.thermal ? spec.widthMm : 216) * PX_PER_MM);
  win.setContentSize(widthPx, 600);
  const cleanup = await loadHtml(win, injectCss(html, buildCss(spec, cfg)));
  try {
    const heightPx = await win.webContents.executeJavaScript(WAIT_AND_MEASURE, true);
    // Un respiro para que el compositor pinte antes de mandar al driver.
    await new Promise((r) => setTimeout(r, 40));

    const opts = {
      silent: true,
      printBackground: true,
      copies: cfg.copies,
      scaleFactor: cfg.scale,
      margins: { marginType: spec.thermal ? 'none' : 'default' },
    };
    if (cfg.printer) opts.deviceName = cfg.printer;
    const sizeMode = driverPageSizeMode(cfg, language, spec.thermal);
    if (sizeMode === 'custom') {
      const heightMm = Math.min(3000, Math.max(30, (heightPx / PX_PER_MM) * (cfg.scale / 100) + 6));
      opts.pageSize = { width: Math.round(spec.widthMm * 1000), height: Math.round(heightMm * 1000) };
    } else if (sizeMode === 'paper' && spec.pageSize) {
      opts.pageSize = spec.pageSize;
    } else {
      // Drivers que no aceptan un tamaño propio (Star futurePRNT): el suyo
      // ("72mm x Receipt"), que además recorta el papel sobrante al final.
      opts.usePrinterDefaultPageSize = true;
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        disposeDriverWindow();
        reject(new Error('El driver de la impresora no respondió a tiempo'));
      }, JOB_TIMEOUT_MS - 2000);
      win.webContents.print(opts, (ok, reason) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error(reason === 'cancelled' ? 'Impresión cancelada' : `El driver rechazó la impresión: ${reason || 'desconocido'}`));
      });
    });
  } finally {
    cleanup();
  }
}

/* ───────────── Imagen (raster) ───────────── */

let renderer = null;
function getRenderer() {
  if (!renderer) renderer = createHtmlRenderer({ BrowserWindow, nativeImage });
  return renderer;
}

/** HTML -> raster monocromo del ancho imprimible (203 dpi). */
async function rasterize(html, cfg, star) {
  const base = paperSpec(cfg);
  const spec = base.thermal ? base : paperSpec({ ...cfg, paper: '80' });
  let dots = Math.floor((spec.printableMm * DOTS_PER_MM) / 8) * 8;
  if (star) dots = Math.min(dots, STAR_MAX_DOTS);
  const offsetDots = Math.max(0, Math.round(cfg.offsetMm * DOTS_PER_MM));
  const cssWidth = spec.printableMm * PX_PER_MM * (100 / cfg.scale);
  const layout = { thermal: true, widthMm: spec.printableMm, printableMm: spec.printableMm };
  const css = buildCss(layout, { ...cfg, offsetMm: 0 }) + 'html,body{background:#fff !important}';
  const img = await getRenderer().render(injectCss(html, css), { cssWidth, widthDots: dots, timeoutMs: JOB_TIMEOUT_MS - 5000 });
  const raster = escpos.bitmapToRaster(img, cfg.threshold, star ? 0 : offsetDots);
  if (!raster.height) throw new Error('El ticket salió vacío');
  return raster;
}

/* ───────────── Trabajos ───────────── */

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Un trabajo a la vez; ninguno detiene la cola más de JOB_TIMEOUT_MS. */
function enqueue(fn) {
  const job = () => withTimeout(Promise.resolve().then(fn), JOB_TIMEOUT_MS, 'La impresora no respondió a tiempo. Revisa que esté encendida y con papel.');
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

function targetLabel(cfg, mode) {
  if (mode === 'usb') return `USB ${cfg.usbDevice || '?'}`;
  if (mode === 'net') return `${cfg.netHost || '?'}:${cfg.netPort}`;
  if (mode === 'star') return `${cfg.printer || '?'} (imagen Star)`;
  if (mode === 'raw') return `${cfg.printer || '?'} (RAW)`;
  return cfg.printer || '(predeterminada)';
}

/**
 * Imprime un trabajo: `html` (página), `bytes` (ESC/POS de Mamux) o ambos.
 * El plan (lib/plan.js) decide según el idioma de la impresora.
 */
function runJob(payload, cfg, name = 'Mamux ticket') {
  return enqueue(async () => {
    const started = Date.now();
    let plan = null;
    let target = targetLabel(cfg, cfg.mode);
    try {
      plan = planJob(cfg, payload, infoFor(cfg));
      target = targetLabel(cfg, plan.mode);
      if (plan.render === 'driver') {
        await printHtmlDriver(payload.html, cfg, plan.language);
      } else {
        let data;
        if (plan.render === 'bytes') {
          const copies = Array.from({ length: Math.max(1, cfg.copies) }, () => payload.bytes);
          data = Buffer.concat(cfg.drawer ? [escpos.PULSO_CAJON, ...copies] : copies);
        } else {
          const star = plan.render === 'raster-star';
          const raster = await rasterize(payload.html, cfg, star);
          const opts = { cut: cfg.cut, drawer: cfg.drawer, copies: cfg.copies };
          data = star ? escpos.buildStarRaster(raster, opts) : escpos.buildEscPos(raster, opts);
        }
        await sendTo(plan.transport, cfg, data);
      }
      const ms = Date.now() - started;
      logJob({ ok: true, printer: `${target} · ${name}`, ms });
      return { ok: true, printer: target, mode: plan.mode, language: plan.language, ms };
    } catch (err) {
      logJob({ ok: false, printer: target, error: err.message });
      throw err;
    }
  });
}

/** ¿Hay destino configurado para imprimir? */
function listo() {
  if (config.mode === 'usb') return !!config.usbDevice;
  if (config.mode === 'net') return !!config.netHost;
  return !!config.printer || process.platform !== 'win32';
}

function effective() {
  return resolveMode(config, infoFor(config));
}

function logJob(j) {
  jobs.unshift({ ...j, at: new Date().toLocaleString('es-MX') });
  jobs.length = Math.min(jobs.length, 30);
  settingsWin?.webContents.send('jobs', jobs);
}

function testTicketHtml(cfg) {
  const spec = paperSpec(cfg);
  const eff = resolveMode(cfg, infoFor(cfg));
  const ruler = spec.thermal
    ? `<div style="box-sizing:border-box;width:100%;border:1px solid #000;height:8mm;position:relative;margin:2mm 0;overflow:hidden">${Array.from({ length: Math.floor(spec.printableMm / 5) + 1 }, (_, i) => `<span style="position:absolute;left:${i * 5}mm;top:0;height:${i % 2 ? 2 : 4}mm;border-left:1px solid #000"></span>`).join('')}<span style="position:absolute;bottom:0;left:1mm;font-size:9px">0</span><span style="position:absolute;bottom:0;right:1mm;font-size:9px">${spec.printableMm} mm</span></div>`
    : '';
  const desc = PAPERS[cfg.paper]?.label || cfg.paper;
  const modo = cfg.mode === 'auto' ? `Automático → ${MODES[eff.mode]}` : MODES[cfg.mode] || cfg.mode;
  return `<html><head><meta charset="utf-8"><style>body{font-family:monospace;font-size:12px;padding:0;background:#fff;color:#000}.p{padding:0 2mm}.c{text-align:center}hr{border:none;border-top:1px dashed #000;margin:6px 0}table{width:100%}.r{text-align:right}</style></head><body>${ruler}<div class="p">
<div class="c"><h2 style="margin:0">MAMUX</h2><p style="margin:2px 0">PRUEBA DE IMPRESIÓN</p></div><hr>
<p>Modo: ${escapeHtml(modo)}</p>
<p>Impresora: ${escapeHtml(targetLabel(cfg, eff.mode))}</p>
<p>Tipo detectado: ${escapeHtml(LANGUAGE_LABEL[eff.language] || eff.language)}</p>
<p>Papel: ${escapeHtml(desc)}${spec.thermal ? ` · imprimible ${spec.printableMm} mm` : ''}</p>
<p>Escala: ${cfg.scale}% · Copias: ${cfg.copies}</p>
<p>Fecha: ${new Date().toLocaleString('es-MX')}</p><hr>
<table><tr><td>1x Producto de prueba</td><td class="r">$100.00</td></tr><tr><td>2x Artículo con nombre largo para probar el corte</td><td class="r">$250.50</td></tr></table><hr>
<table><tr><td><b>TOTAL</b></td><td class="r"><b>$350.50</b></td></tr></table><hr>
<p>ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 ñ á é í ó ú</p>
<div class="c"><p>Si la regla se ve completa,<br>el ancho es correcto.</p></div></div>${ruler}</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function listPrinters() {
  const w = settingsWin && !settingsWin.isDestroyed() ? settingsWin : getDriverWindow();
  const [list] = await Promise.all([w.webContents.getPrintersAsync(), refreshSystemPrinters()]);
  return list.map((p) => {
    const sys = printerInfo.get(p.name);
    const driver = (sys && sys.driver) || systemPrinters.driverFromElectron(p);
    if (driver && !(sys && sys.driver)) printerInfo.set(p.name, { ...(sys || {}), driver });
    const language = detectLanguage({ name: p.name, driver }).language;
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!(p.isDefault || p.options?.['printer-is-default'] === 'true'),
      status: p.status,
      driver: driver || '',
      language,
      languageLabel: LANGUAGE_LABEL[language],
    };
  });
}

/* ───────────── Servidor HTTP local ───────────── */

/** Cualquier página puede pedir imprimir: el agente solo escucha en esta
 * computadora (127.0.0.1) y únicamente imprime. */
function originAllowed() {
  return true;
}

function send(res, status, data, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Contenido demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function healthPayload() {
  const eff = effective();
  const info = infoFor(config);
  return {
    ready: listo(),
    printer: targetLabel(config, eff.mode),
    platform: process.platform,
    version: app.getVersion(),
    // `mode` es el modo con el que de verdad se imprime (Mamux viejo lo usa para
    // decidir si manda página o bytes); `configuredMode` el elegido en la ventana.
    mode: eff.mode,
    configuredMode: config.mode,
    language: eff.language,
    languageLabel: LANGUAGE_LABEL[eff.language] || null,
    driver: info.driver || null,
    api: API_VERSION,
    accepts: ['html', 'bytes', 'html+bytes'],
  };
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return send(res, 403, { ok: false, error: 'Origen no permitido' });
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') return send(res, 204, undefined, origin);

  if (req.method === 'GET' && url.pathname === '/status') {
    const h = healthPayload();
    return send(res, 200, { ok: true, app: 'mamux-print-agent', ...h, paper: config.paper }, origin);
  }
  // Compatibilidad con Mamux (mismo contrato que el agente anterior + campos nuevos).
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, healthPayload(), origin);
  }
  if (req.method === 'GET' && url.pathname === '/printers') {
    const printers = await listPrinters();
    const usb = await escpos.listUsbPrinters().catch(() => []);
    return send(res, 200, {
      ok: true,
      printers,
      usb,
      impresoras: printers.map((p) => p.name),
      actual: ['auto', 'driver', 'raw', 'star'].includes(config.mode) ? config.printer || null : null,
    }, origin);
  }
  if (req.method === 'POST' && url.pathname === '/set-printer') {
    try {
      const body = JSON.parse(await readBody(req));
      if (typeof body.name !== 'string' || !body.name.trim()) return send(res, 400, { ok: false, error: 'Falta el nombre de la impresora' }, origin);
      if (!printerInfo.has(body.name.trim())) await refreshSystemPrinters();
      saveConfig({ printer: body.name.trim(), mode: ['auto', 'driver', 'raw', 'star'].includes(config.mode) ? config.mode : 'auto' });
      settingsWin?.webContents.send('config', config);
      return send(res, 200, { ok: true, printer: config.printer, mode: effective().mode }, origin);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message }, origin);
    }
  }
  if (req.method === 'POST' && url.pathname === '/print') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'Falta el ticket' }, origin);
      const { html, dataBase64, name, ...overrides } = body;
      const payload = {
        html: typeof html === 'string' && html.trim() ? html : null,
        bytes: typeof dataBase64 === 'string' && dataBase64 ? Buffer.from(dataBase64, 'base64') : null,
      };
      if (!payload.html && !(payload.bytes && payload.bytes.length)) return send(res, 400, { ok: false, error: 'Falta html o dataBase64' }, origin);
      const jobName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'Mamux ticket';
      const cfg = { ...config, ...sanitize(overrides) };
      return send(res, 200, await runJob(payload, cfg, jobName), origin);
    } catch (err) {
      return send(res, err instanceof PlanError ? 422 : 500, { ok: false, error: err.message, code: err.code || null }, origin);
    }
  }
  if (req.method === 'POST' && url.pathname === '/test') {
    try {
      return send(res, 200, await runJob({ html: testTicketHtml(config) }, config, 'Prueba'), origin);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message }, origin);
    }
  }
  return send(res, 404, { ok: false, error: 'No encontrado' }, origin);
}

function startServer() {
  if (server) server.close();
  serverError = '';
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { ok: false, error: err.message }));
  });
  server.on('error', (err) => {
    serverError = err.code === 'EADDRINUSE' ? `El puerto ${config.port} ya está en uso` : err.message;
    settingsWin?.webContents.send('status', status());
  });
  server.listen(config.port, '127.0.0.1', () => settingsWin?.webContents.send('status', status()));
}

function status() {
  return { listening: !!server?.listening, port: config.port, error: serverError, version: app.getVersion() };
}

/* ───────────── UI ───────────── */

function trayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 800,
    title: 'Mamux Print Agent',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Mamux Print Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Configuración', click: openSettings },
    { label: 'Imprimir prueba', click: () => runJob({ html: testTicketHtml(config) }, config, 'Prueba').catch((e) => notify(e.message)) },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', openSettings);
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Mamux Print Agent', body }).show();
}

ipcMain.handle('get-config', () => ({
  config,
  papers: PAPERS,
  modes: MODES,
  languages: LANGUAGES,
  driverPageSizes: DRIVER_PAGE_SIZES,
  effective: effective(),
  modeLabels: MODES,
}));
ipcMain.handle('get-usb', () => escpos.listUsbPrinters());
ipcMain.handle('save-config', (_e, c) => saveConfig(c));
ipcMain.handle('get-printers', () => listPrinters());
ipcMain.handle('get-status', () => status());
ipcMain.handle('get-jobs', () => jobs);
ipcMain.handle('resolve-mode', (_e, c) => {
  const cfg = { ...config, ...sanitize(c || {}) };
  if (c && 'printer' in c && c.printer !== config.printer) cfg.printerDriver = '';
  return resolveMode(cfg, infoFor(cfg));
});
ipcMain.handle('test-print', async (_e, c) => {
  const cfg = { ...config, ...sanitize(c || {}) };
  try {
    const r = await runJob({ html: testTicketHtml(cfg) }, cfg, 'Prueba');
    return { ok: true, ms: r.ms, mode: r.mode };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openSettings);
  app.whenReady().then(() => {
    loadConfig();
    applyAutoStart();
    startServer();
    createTray();
    // Todo listo antes del primer ticket: PowerShell + clase winspool compilada,
    // ventana de render y lista de drivers.
    if (winspoolWorker) void winspoolWorker.warm();
    getRenderer().warm();
    void refreshSystemPrinters();
    if (!process.argv.includes('--hidden')) openSettings();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    app.isQuitting = true;
    if (winspoolWorker) winspoolWorker.stop();
  });
}
