const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const HISTORY_KEY = 'apiDash.history';

let current = null;
let headersMode = 'text';
let bodyMode = 'json';

// ---------- Key/value rows (used by Params, Headers form, Body form) ----------
function addRow(container, k = '', v = '') {
  const row = document.createElement('div');
  row.className = 'flex gap-2';
  row.innerHTML = `
    <input class="field flex-1 font-mono text-sm" placeholder="key">
    <input class="field flex-1 font-mono text-sm" placeholder="value">
    <button class="btn-sm text-red-400" title="Remove">✕</button>`;
  const [a, b] = row.querySelectorAll('input');
  a.value = k;
  b.value = v;
  row.querySelector('button').onclick = () => { row.remove(); updateUrl(); };
  row.addEventListener('input', updateUrl);
  container.appendChild(row);
}

function readRows(container) {
  return [...container.children]
    .map(r => { const [a, b] = r.querySelectorAll('input'); return [a.value.trim(), b.value]; })
    .filter(([k]) => k);
}

// ---------- URL + params ----------
function buildUrl() {
  const base = $('#url').value.trim();
  if (!base) return '';
  const pairs = readRows($('#paramRows'));
  if (!pairs.length) return base;
  const qs = new URLSearchParams(pairs).toString();
  return base + (base.includes('?') ? '&' : '?') + qs;
}

function updateUrl() {
  $('#finalUrl').textContent = buildUrl() || '—';
}

// ---------- Tabs (headers / body / output) ----------
$$('.tab').forEach(btn => btn.onclick = () => {
  const g = btn.dataset.group, m = btn.dataset.mode;
  $$(`.tab[data-group="${g}"]`).forEach(b => b.classList.toggle('active', b === btn));

  if (g === 'headers') {
    headersMode = m;
    $('#headersText').classList.toggle('hidden', m !== 'text');
    $('#headersForm').classList.toggle('hidden', m !== 'form');
  }
  if (g === 'body') {
    bodyMode = m;
    $('#bodyText').classList.toggle('hidden', m === 'form');
    $('#bodyForm').classList.toggle('hidden', m !== 'form');
  }
  if (g === 'output') {
    $('#viewTree').classList.toggle('hidden', m !== 'tree');
    $('#viewHtml').classList.toggle('hidden', m !== 'html');
  }
});

// ---------- Headers & body ----------
function setDefault(h, k, v) {
  if (!Object.keys(h).some(x => x.toLowerCase() === k.toLowerCase())) h[k] = v;
}

function getHeaders() {
  if (headersMode === 'form') return Object.fromEntries(readRows($('#headerRows')));
  const raw = $('#headersText').value.trim();
  if (!raw) return {};
  if (raw.startsWith('{')) return JSON.parse(raw);           // JSON object form
  const h = {};
  raw.split('\n').forEach(line => {                          // "Key: Value" lines
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return h;
}

function getBody(method, headers) {
  if (method === 'GET' || method === 'HEAD') return undefined;

  if (bodyMode === 'form') {
    setDefault(headers, 'Content-Type', 'application/x-www-form-urlencoded');
    return new URLSearchParams(readRows($('#bodyRows'))).toString() || undefined;
  }

  const raw = $('#bodyText').value;
  if (!raw.trim()) return undefined;
  if (bodyMode === 'json') {
    JSON.parse(raw);                                         // validate before sending
    setDefault(headers, 'Content-Type', 'application/json');
  }
  return raw;
}

// ---------- Send ----------
async function send() {
  const method = $('#method').value;
  const url = buildUrl();
  if (!url) return showError('Enter a URL first.');

  let headers, body;
  try {
    headers = getHeaders();
    body = getBody(method, headers);
  } catch (e) {
    return showError('Invalid input: ' + e.message);
  }

  setStatus('…', '');
  $('#meta').textContent = 'Sending…';
  const t0 = performance.now();

  try {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    current = {
      at: new Date().toISOString(),
      request: { method, url, headers, body: body ?? null },
      response: {
        status: res.status,
        statusText: res.statusText,
        time: Math.round(performance.now() - t0),
        size: new Blob([text]).size,
        headers: Object.fromEntries(res.headers.entries()),
        body: text
      }
    };
    render(current);
  } catch (e) {
    showError(`${e.message}. If this is a CORS error, the server must allow this page's origin.`);
  }
}

// ---------- Render output ----------
function setStatus(code, cls) {
  const el = $('#status');
  el.textContent = code;
  el.className = 'status-box ' + cls;
}

function statusClass(code) {
  if (code >= 200 && code < 300) return 'ok';
  if (code >= 300 && code < 400) return 'redir';
  if (code >= 400) return 'err';
  return '';
}

function fmtBytes(n) {
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}

function render(entry) {
  const r = entry.response;
  setStatus(r.status, statusClass(r.status));
  $('#status').title = r.statusText;
  $('#meta').textContent = `${r.time} ms · ${fmtBytes(r.size)} · ${entry.request.method}`;
  renderTree(r.body);
  $('#viewHtml').srcdoc = r.body;
}

function showError(msg) {
  setStatus('ERR', 'err');
  $('#meta').textContent = msg;
  $('#viewTree').textContent = msg;
}

// ---------- JSON tree ----------
function renderTree(text) {
  const box = $('#viewTree');
  box.innerHTML = '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const pre = document.createElement('pre');
    pre.textContent = text || '(empty body)';
    box.appendChild(pre);
    return;
  }
  box.appendChild(buildNode(null, data, 0));
}

function buildNode(key, val, depth) {
  if (val === null || typeof val !== 'object') {
    const row = document.createElement('div');
    row.className = 'leaf';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key === null ? '' : key + ': ';
    const v = document.createElement('span');
    v.className = typeof val === 'string' ? 'str'
                : typeof val === 'number' ? 'num'
                : typeof val === 'boolean' ? 'bool' : 'nul';
    v.textContent = JSON.stringify(val);
    row.append(k, v);
    return row;
  }

  const arr = Array.isArray(val);
  const count = Object.keys(val).length;
  const d = document.createElement('details');
  d.open = depth < 2;

  const s = document.createElement('summary');
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key === null ? (arr ? '[root]' : '{root}') : key;
  const m = document.createElement('span');
  m.className = 'meta';
  m.textContent = ' ' + (arr ? `[ ${count} ]` : `{ ${count} }`);
  s.append(k, m);
  d.appendChild(s);

  for (const kk of Object.keys(val)) {
    d.appendChild(buildNode(arr ? `[${kk}]` : kk, val[kk], depth + 1));
  }
  return d;
}

// ---------- Local storage: save / history ----------
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 50)));
  } catch (e) {
    alert('Could not save: ' + e.message);
  }
}

function renderHistory() {
  const ul = $('#history');
  ul.innerHTML = '';
  getHistory().forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-2';

    const b = document.createElement('button');
    b.className = 'flex-1 text-left truncate hover:text-violet-300';
    b.textContent = `${e.request.method} ${e.request.url} → ${e.response.status}`;
    b.onclick = () => { current = e; render(e); };

    const del = document.createElement('button');
    del.className = 'text-red-400 text-xs';
    del.textContent = 'delete';
    del.onclick = () => {
      const list = getHistory();
      list.splice(i, 1);
      saveHistory(list);
      renderHistory();
    };

    li.append(b, del);
    ul.appendChild(li);
  });
}

$('#save').onclick = () => {
  if (!current) return alert('Send a request first.');
  const list = getHistory();
  list.unshift(current);
  saveHistory(list);
  renderHistory();
};

// ---------- Export ----------
$('#export').onclick = () => {
  if (!current) return alert('Send a request first.');
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `response-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------- Layout swap (request ⇄ response) ----------
$('#swap').onclick = () => {
  $('#main').classList.toggle('flex-col');
  $('#main').classList.toggle('flex-col-reverse');
};

// ---------- Wiring ----------
$('#send').onclick = send;
$('#url').addEventListener('input', updateUrl);
$('#addParam').onclick = () => { addRow($('#paramRows')); updateUrl(); };
$('#addHeader').onclick = () => addRow($('#headerRows'));
$('#addBody').onclick = () => addRow($('#bodyRows'));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send();
});

updateUrl();
renderHistory();