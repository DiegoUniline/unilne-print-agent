const $ = (id) => document.getElementById(id);
const FIELDS = ['mode', 'language', 'driverPageSize', 'printer', 'usbDevice', 'netHost', 'netPort', 'cut', 'drawer', 'threshold', 'paper', 'customWidthMm', 'printableMm', 'offsetMm', 'scale', 'copies', 'forceBlack', 'autoStart', 'port'];
let papers = {};
let modeLabels = {};
let printerList = [];

function readForm() {
  const c = {};
  for (const f of FIELDS) {
    const el = $(f);
    c[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  return c;
}

function fillForm(c) {
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!c[f];
    else el.value = c[f] ?? '';
  }
  toggleMode();
}

const HINTS = {
  auto: 'Mamux Print Agent reconoce la impresora por su driver y elige solo cómo imprimir: Star TSP100 como imagen Star, térmicas ESC/POS directo (RAW) y cualquier otra con su driver.',
  driver: 'Usa el driver instalado (impresoras de Configuración > Impresoras). Si la prueba sale en blanco cambia "Tamaño de página con el driver".',
  usb: 'Para impresoras térmicas conectadas por USB sin driver de Windows (como en Poster). Requiere driver WinUSB/libusbK.',
  raw: 'Recomendado. Envía el ticket de Mamux tal cual (ESC/POS) a la impresora instalada en el equipo, p. ej. la térmica o "Generic / Text Only".',
  net: 'Impresoras térmicas con cable de red o WiFi (puerto 9100).',
  star: 'Para Star TSP100 / TSP143 (futurePRNT): manda el ticket como imagen en el lenguaje de Star, sin depender del driver. Elige la impresora Star instalada en Windows.',
};

async function refreshDetected() {
  const m = $('mode').value;
  const r = await window.agent.resolveMode(readForm());
  const p = printerList.find((x) => x.name === $('printer').value);
  const driver = p && p.driver ? ` · driver «${p.driver}»` : '';
  $('detected').innerHTML = '';
  const b = document.createElement('b');
  b.textContent = modeLabels[r.mode] || r.mode;
  $('detected').append('Se imprimirá con: ', b, driver);
  $('driverSizeWrap').classList.toggle('hidden', !(m === 'driver' || (m === 'auto' && r.mode === 'driver')) || !['58', '80', 'custom'].includes($('paper').value));
}

function toggleMode() {
  const m = $('mode').value;
  $('winWrap').classList.toggle('hidden', !['auto', 'driver', 'raw', 'star'].includes(m));
  $('autoWrap').classList.toggle('hidden', m !== 'auto');
  $('usbWrap').classList.toggle('hidden', m !== 'usb');
  $('netWrap').classList.toggle('hidden', m !== 'net');
  $('escposWrap').classList.toggle('hidden', m === 'driver');
  $('hint').textContent = HINTS[m] || '';
  const pagina = m === 'driver' || m === 'auto';
  if (!pagina && !['58', '80', 'custom'].includes($('paper').value)) {
    $('paper').value = '80';
    $('printableMm').value = 72;
  }
  [...$('paper').options].forEach((o) => { o.disabled = !pagina && !['58', '80', 'custom'].includes(o.value); });
  toggleThermal();
  refreshDetected();
}

async function loadUsb(selected) {
  const sel = $('usbDevice');
  sel.innerHTML = '<option value="">Buscando…</option>';
  const list = await window.agent.getUsb();
  sel.innerHTML = list.length ? '' : '<option value="">No se encontraron impresoras USB</option>';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  if (selected && !list.some((p) => p.id === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = `USB ${selected} (no conectada)`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

function toggleThermal() {
  const p = $('paper').value;
  $('thermal').classList.toggle('hidden', !['58', '80', 'custom'].includes(p));
  $('customWrap').classList.toggle('hidden', p !== 'custom');
}

function msg(text, kind) {
  $('msg').textContent = text;
  $('msg').className = kind || '';
}

async function loadPrinters(selected) {
  const sel = $('printer');
  sel.innerHTML = '<option value="">Predeterminada del sistema</option>';
  const list = await window.agent.getPrinters();
  printerList = list;
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.displayName + (p.isDefault ? ' (predeterminada)' : '') + (p.language === 'star' ? ' · Star' : p.language === 'escpos' ? ' · térmica' : '');
    sel.appendChild(o);
  }
  if (selected && !list.some((p) => p.name === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = `${selected} (no conectada)`;
    sel.appendChild(o);
  }
  sel.value = selected || '';
}

function renderStatus(s) {
  const el = $('status');
  if (s.listening) { el.textContent = `Activo · 127.0.0.1:${s.port}`; el.className = 'pill ok'; }
  else { el.textContent = s.error || 'Detenido'; el.className = 'pill err'; }
}

function renderJobs(jobs) {
  const ul = $('jobs');
  ul.innerHTML = '';
  if (!jobs.length) { ul.innerHTML = '<li>Sin impresiones</li>'; return; }
  for (const j of jobs) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = `${j.at} · ${j.printer}`;
    const b = document.createElement('span');
    b.className = j.ok ? 'o' : 'e';
    b.textContent = j.ok ? `OK ${j.ms} ms` : j.error;
    li.append(a, b);
    ul.appendChild(li);
  }
}

$('paper').addEventListener('change', () => {
  const p = papers[$('paper').value];
  if (p?.printableMm) $('printableMm').value = p.printableMm;
  if ($('paper').value === 'custom') $('printableMm').value = Math.max(20, Number($('customWidthMm').value) - 8);
  toggleThermal();
  refreshDetected();
});

$('refresh').addEventListener('click', () => loadPrinters($('printer').value));
$('refreshUsb').addEventListener('click', () => loadUsb($('usbDevice').value));
$('mode').addEventListener('change', toggleMode);
$('printer').addEventListener('change', refreshDetected);
$('language').addEventListener('change', refreshDetected);

$('save').addEventListener('click', async () => {
  fillForm(await window.agent.saveConfig(readForm()));
  msg('Configuración guardada', 'ok');
});

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  msg('Imprimiendo…');
  const r = await window.agent.testPrint(readForm());
  $('test').disabled = false;
  msg(r.ok ? `Prueba enviada a la impresora (${r.ms} ms)` : `Error: ${r.error}`, r.ok ? 'ok' : 'err');
});

(async () => {
  const { config, papers: p, modes, languages, driverPageSizes } = await window.agent.getConfig();
  papers = p;
  modeLabels = modes;
  const opts = (o) => Object.entries(o).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('language').innerHTML = opts(languages);
  $('driverPageSize').innerHTML = opts(driverPageSizes);
  $('mode').innerHTML = Object.entries(modes).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('paper').innerHTML = Object.entries(p).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  await Promise.all([loadPrinters(config.printer), loadUsb(config.usbDevice)]);
  fillForm(config);
  renderStatus(await window.agent.getStatus());
  renderJobs(await window.agent.getJobs());
  window.agent.onStatus(renderStatus);
  window.agent.onJobs(renderJobs);
})();
