const $ = (id) => document.getElementById(id);
const api = window.dikte;

const LANG_NAMES = { tr: 'Türkçe', en: 'English', es: 'Español' };
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mp3|m4a|wav|aac|ogg|flac)$/i;
const MIN_LEN = 200; // bir satırın en kısa süresi (ms)
const MAX_CPS = 21; // okuma hızı sınırı (karakter / saniye)

const video = $('video');

const state = {
  lang: localStorage.getItem('dikte.lang') || 'tr',
  file: null,
  segments: [], // { id, start, end, text, top }
  wave: null, // { peaks, rate, duration }
  doneLang: null,
  busy: false,
  selected: null,
  dirty: false,
};
let nextId = 1;

/* =========================================================
   Yardımcılar
   ========================================================= */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const findIdx = (id) => state.segments.findIndex((s) => s.id === id);
const selSeg = () => state.segments.find((s) => s.id === state.selected) || null;
const nowMs = () => Math.round(video.currentTime * 1000);
const durationMs = () => Math.round((state.wave?.duration || video.duration || 0) * 1000);

function fmt(ms) {
  ms = Math.max(0, Math.round(ms));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function parseTime(str) {
  const parts = str.trim().replace(',', '.').split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return Math.round(parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0) * 1000);
}
const isTyping = (el) => el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

/* =========================================================
   Geri al / yinele
   ========================================================= */
const hist = { undo: [], redo: [] };
const snapshot = () => JSON.stringify(state.segments);

function commit(before = snapshot()) {
  hist.undo.push(before);
  if (hist.undo.length > 300) hist.undo.shift();
  hist.redo = [];
  state.dirty = true;
  updateUndoButtons();
}
function restore(json) {
  state.segments = JSON.parse(json);
  if (!selSeg()) state.selected = null;
  state.dirty = true;
  refreshAll();
}
function undo() {
  if (!hist.undo.length) return;
  hist.redo.push(snapshot());
  restore(hist.undo.pop());
}
function redo() {
  if (!hist.redo.length) return;
  hist.undo.push(snapshot());
  restore(hist.redo.pop());
}
function updateUndoButtons() {
  $('btn-undo').disabled = !hist.undo.length;
  $('btn-redo').disabled = !hist.redo.length;
}
// Menüdeki ⌘Z: yazı alanındaysan yazıyı, değilsen altyazı düzenlemesini geri alır
api.onEdit((what) => {
  if (isTyping(document.activeElement)) document.execCommand(what);
  else if (what === 'undo') undo();
  else redo();
});
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

/* =========================================================
   Ekranlar, dil
   ========================================================= */
function show(screen) {
  for (const id of ['setup', 'empty', 'work']) $(id).classList.toggle('hidden', id !== screen);
  if (screen === 'work') requestAnimationFrame(resizeTimeline);
}

function renderLang() {
  document.querySelectorAll('.lang').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.lang === state.lang));
    b.disabled = state.busy;
  });
  $('empty-lang').textContent = LANG_NAMES[state.lang];
  const needRelang = state.doneLang && state.doneLang !== state.lang && !state.busy;
  $('relang').classList.toggle('hidden', !needRelang);
  $('btn-relang').textContent = `${LANG_NAMES[state.lang]} olarak yeniden yaz`;
}
document.querySelectorAll('.lang').forEach((b) =>
  b.addEventListener('click', () => {
    if (state.busy) return;
    state.lang = b.dataset.lang;
    localStorage.setItem('dikte.lang', state.lang);
    renderLang();
  })
);

/* =========================================================
   Kurulum
   ========================================================= */
async function checkSetup() {
  const s = await api.checkSetup();
  $('chk-ffmpeg').classList.toggle('ok', s.ffmpeg);
  $('chk-whisper').classList.toggle('ok', s.whisper);
  $('chk-model').classList.toggle('ok', s.model);
  $('btn-download').classList.toggle('hidden', s.model);
  if (s.ffmpeg && s.whisper && s.model) show(state.file ? 'work' : 'empty');
  else show('setup');
}
$('btn-recheck').addEventListener('click', checkSetup);
$('btn-download').addEventListener('click', async () => {
  $('btn-download').disabled = true;
  $('model-dl').classList.remove('hidden');
  try {
    await api.downloadModel();
    await checkSetup();
  } catch (e) {
    $('model-text').textContent = e.message;
  } finally {
    $('btn-download').disabled = false;
  }
});
api.onModelProgress(({ got, total }) => {
  const mb = (n) => (n / 1048576).toFixed(0);
  $('model-bar').style.width = total ? `${(got / total) * 100}%` : '0';
  $('model-text').textContent = total ? `${mb(got)} / ${mb(total)} MB` : `${mb(got)} MB`;
});

/* =========================================================
   Dosya alma
   ========================================================= */
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!$('empty').classList.contains('hidden')) drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === drop) drop.classList.remove('over');
  })
);
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (!f || state.busy) return;
  const p = api.pathForFile(f);
  if (!VIDEO_EXT.test(p)) return showError('Bu dosya türü desteklenmiyor. Video ya da ses dosyası bırak.');
  if (state.dirty && !confirm('Kaydedilmemiş düzenlemeler kaybolacak. Yeni dosyayı açayım mı?')) return;
  openFile(p);
});
$('btn-pick').addEventListener('click', async () => {
  const p = await api.pickVideo();
  if (p) openFile(p);
});
$('btn-new').addEventListener('click', () => {
  if (state.busy) return;
  if (state.dirty && !confirm('Kaydedilmemiş düzenlemeler kaybolacak. Devam edeyim mi?')) return;
  video.pause();
  state.file = null;
  state.segments = [];
  state.wave = null;
  state.doneLang = null;
  state.selected = null;
  state.dirty = false;
  hist.undo = [];
  hist.redo = [];
  video.removeAttribute('src');
  video.load();
  renderLang();
  show('empty');
});

async function openFile(p) {
  state.file = p;
  state.segments = [];
  state.wave = null;
  state.doneLang = null;
  state.selected = null;
  state.dirty = false;
  hist.undo = [];
  hist.redo = [];
  $('file-name').textContent = p.split('/').pop();
  $('file-name').title = p;
  video.src = await api.videoUrl(p);
  tl.pps = 0;
  tl.view = 0;
  hideError();
  refreshAll();
  show('work');
  transcribe();
}

/* =========================================================
   Yazıya dökme
   ========================================================= */
function setStatus(text, progress, cancellable = false) {
  $('status').classList.remove('hidden');
  $('btn-cancel').classList.toggle('hidden', !cancellable);
  $('status-text').textContent = text;
  const bar = $('status-bar').parentElement;
  bar.classList.toggle('indet', progress == null);
  if (progress != null) $('status-bar').style.width = `${progress}%`;
}
api.onStage(({ stage, progress }) => {
  if (stage === 'audio') setStatus('Ses ayrıştırılıyor…', null, true);
  if (stage === 'whisper') setStatus(`Yazıya dökülüyor (${LANG_NAMES[state.lang]})… %${progress}`, progress, true);
});

async function transcribe() {
  if (state.busy) return;
  state.busy = true;
  hideError();
  $('saved').classList.add('hidden');
  renderLang();
  setButtons();
  setStatus('Hazırlanıyor…', null, true);
  const t0 = performance.now();
  try {
    const { segments, wave } = await api.transcribe(state.file, state.lang);
    state.segments = segments.map((s) => ({ ...s, id: nextId++, top: false }));
    state.wave = wave;
    state.doneLang = state.lang;
    state.selected = null;
    state.dirty = false;
    hist.undo = [];
    hist.redo = [];
    tl.pps = 0;
    refreshAll();
    resizeTimeline();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Bitti · ${segments.length} satır · ${secs} sn`, 100);
    setTimeout(() => !state.busy && $('status').classList.add('hidden'), 2500);
  } catch (e) {
    $('status').classList.add('hidden');
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (!/İptal/.test(msg)) showError(msg);
  } finally {
    state.busy = false;
    renderLang();
    setButtons();
  }
}
$('btn-cancel').addEventListener('click', () => api.cancel());
$('btn-relang').addEventListener('click', () => {
  if (state.dirty && !confirm('Yeniden yazınca yaptığın düzenlemeler kaybolacak. Devam edeyim mi?')) return;
  transcribe();
});

function showError(msg) {
  $('error').textContent = msg;
  $('error').classList.remove('hidden');
}
function hideError() {
  $('error').classList.add('hidden');
}

/* =========================================================
   Satır listesi
   ========================================================= */
function issuesOf(i) {
  const s = state.segments[i];
  const next = state.segments[i + 1];
  const out = [];
  const d = (s.end - s.start) / 1000;
  if (d <= 0) out.push(['err', 'süre yok']);
  else if (next && s.end > next.start) out.push(['err', 'çakışıyor']);
  if (d > 0 && d < 0.5) out.push(['warn', 'çok kısa']);
  if (d > 0 && s.text.trim().length / d > MAX_CPS) out.push(['warn', 'hızlı']);
  return out;
}

function renderList() {
  const list = $('segments');
  list.innerHTML = '';
  $('seg-count').textContent = state.segments.length ? `${state.segments.length} satır` : '';
  if (!state.segments.length) {
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = state.file ? 'Altyazılar burada görünecek.' : '';
    list.appendChild(p);
    return;
  }
  state.segments.forEach((seg) => list.appendChild(buildRow(seg)));
  updateRows();
}

function buildRow(seg) {
  const row = document.createElement('div');
  row.className = 'seg';
  row.dataset.id = seg.id;
  row.innerHTML = `
    <div class="meta">
      <span class="num"></span>
      <input class="t t-start" spellcheck="false" title="Başlangıç (I tuşu: şu anki zaman)">
      <span class="arrow">→</span>
      <input class="t t-end" spellcheck="false" title="Bitiş (O tuşu: şu anki zaman)">
      <span class="dur"></span>
      <span class="flags"></span>
      <span class="spacer"></span>
      <button class="mini pos" title="Ekranın üstünde göster (alttaki yazıyla çakışıyorsa)">Üstte</button>
      <button class="mini play" title="Bu satırı oynat (P)">▶</button>
    </div>
    <div class="txt" spellcheck="false"></div>`;

  const txt = row.querySelector('.txt');
  txt.contentEditable = 'plaintext-only';
  txt.textContent = seg.text;

  row.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    select(seg.id, { seek: !isTyping(e.target) && !e.target.closest('.txt'), scroll: false });
  });

  // metin
  let typedBefore = null;
  txt.addEventListener('focus', () => (typedBefore = null));
  txt.addEventListener('input', () => {
    if (typedBefore === null) {
      typedBefore = snapshot();
      commit(typedBefore);
    }
    seg.text = txt.textContent;
    updateRows();
    updateOverlay();
    drawTimeline();
  });

  // zaman kutuları
  for (const [cls, key] of [['.t-start', 'start'], ['.t-end', 'end']]) {
    const input = row.querySelector(cls);
    const apply = () => {
      const v = parseTime(input.value);
      if (v == null) {
        input.classList.add('bad');
        setTimeout(() => input.classList.remove('bad'), 900);
        input.value = fmt(seg[key]);
        return;
      }
      if (v === seg[key]) return;
      if (key === 'end' ? v < seg.start + MIN_LEN : v > seg.end - MIN_LEN) {
        input.classList.add('bad');
        setTimeout(() => input.classList.remove('bad'), 900);
        input.value = fmt(seg[key]);
        return flash('Bitiş, başlangıçtan en az 0,2 sn sonra olmalı');
      }
      commit();
      seg[key] = clamp(v, 0, durationMs() || v);
      refreshTiming();
      video.currentTime = seg[key] / 1000;
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = fmt(seg[key]);
        input.blur();
      }
      // ↑/↓ ile 10 ms (⇧: 100 ms) ince ayar
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = (e.shiftKey ? 100 : 10) * (e.key === 'ArrowUp' ? 1 : -1);
        const v =
          key === 'start'
            ? clamp(seg.start + step, 0, seg.end - MIN_LEN)
            : clamp(seg.end + step, seg.start + MIN_LEN, durationMs() || Infinity);
        if (v === seg[key]) return;
        commit();
        seg[key] = v;
        input.value = fmt(seg[key]);
        refreshTiming(input);
        video.currentTime = seg[key] / 1000;
      }
    });
    input.addEventListener('blur', apply);
  }

  row.querySelector('.pos').addEventListener('click', () => {
    commit();
    seg.top = !seg.top;
    updateRows();
    updateOverlay();
  });
  row.querySelector('.play').addEventListener('click', () => {
    select(seg.id, { seek: false, scroll: false });
    playSegment(seg);
  });
  return row;
}

// Satırların sayılarını, sürelerini, uyarılarını ve seçili durumunu tazele (DOM'u yeniden kurmadan)
function updateRows(skipInput) {
  const rows = $('segments').querySelectorAll('.seg');
  const t = nowMs();
  state.segments.forEach((seg, i) => {
    const row = rows[i];
    if (!row) return;
    row.querySelector('.num').textContent = i + 1;
    for (const [cls, key] of [['.t-start', 'start'], ['.t-end', 'end']]) {
      const input = row.querySelector(cls);
      if (input !== skipInput && document.activeElement !== input) input.value = fmt(seg[key]);
    }
    row.querySelector('.dur').textContent = `${((seg.end - seg.start) / 1000).toFixed(1)} sn`;
    row.querySelector('.flags').innerHTML = issuesOf(i)
      .map(([k, label]) => `<span class="flag ${k}">${label}</span>`)
      .join(' ');
    row.querySelector('.pos').classList.toggle('on', !!seg.top);
    row.classList.toggle('selected', seg.id === state.selected);
    row.classList.toggle('active', t >= seg.start && t < seg.end);
  });
}

function refreshTiming(skipInput) {
  updateRows(skipInput);
  updateOverlay();
  drawTimeline();
}
function refreshAll() {
  renderList();
  updateOverlay();
  drawTimeline();
  setButtons();
  updateUndoButtons();
}

function select(id, { seek = true, scroll = true } = {}) {
  state.selected = id;
  const seg = selSeg();
  updateRows();
  if (seg) {
    if (seek) {
      video.currentTime = seg.start / 1000;
    }
    ensureVisible(seg.start, seg.end);
    if (scroll) $('segments').querySelector(`.seg[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  drawTimeline();
}

function setButtons() {
  const has = state.segments.length > 0 && !state.busy;
  ['btn-copy', 'btn-txt', 'btn-srt'].forEach((id) => ($(id).disabled = !has));
  $('btn-new').disabled = state.busy;
  $('editor').classList.toggle('hidden', !state.wave);
}

/* =========================================================
   Düzenleme işlemleri
   ========================================================= */
function neighbours(seg) {
  const i = findIdx(seg.id);
  const prev = state.segments[i - 1];
  const next = state.segments[i + 1];
  return { lo: prev ? prev.end : 0, hi: next ? next.start : durationMs() };
}

// I / O: seçili satırın başını/sonunu oynatma çizgisine getir. Süre ters dönerse diğer ucu da kaydır.
function setEdge(which) {
  const s = selSeg();
  if (!s) return flash('Önce bir satır seç');
  const t = nowMs();
  const len = Math.max(MIN_LEN, s.end - s.start);
  commit();
  if (which === 'start') {
    s.start = t;
    if (s.end < t + MIN_LEN) s.end = t + len;
  } else {
    s.end = t;
    if (s.start > t - MIN_LEN) s.start = Math.max(0, t - len);
  }
  refreshTiming();
}

function nudge(seg, delta) {
  const { lo, hi } = neighbours(seg);
  const len = seg.end - seg.start;
  const start = clamp(seg.start + delta, lo, Math.max(lo, hi - len));
  if (start === seg.start) return;
  commit();
  seg.start = start;
  seg.end = start + len;
  refreshTiming();
}

function shiftAll(delta) {
  if (!state.segments.length) return;
  const first = state.segments[0].start;
  const last = state.segments.at(-1).end;
  const d = clamp(delta, -first, Math.max(0, durationMs() - last));
  if (!d) return;
  commit();
  for (const s of state.segments) {
    s.start += d;
    s.end += d;
  }
  refreshTiming();
  flash(`Tümü ${d > 0 ? '+' : '−'}${Math.abs(d / 1000).toFixed(1)} sn kaydırıldı`);
}

function splitSelected() {
  const s = selSeg();
  if (!s) return flash('Önce bir satır seç');
  let t = nowMs();
  if (t <= s.start + MIN_LEN || t >= s.end - MIN_LEN) t = Math.round((s.start + s.end) / 2);
  const words = s.text.trim().split(/\s+/);
  const k = words.length < 2 ? words.length : clamp(Math.round((words.length * (t - s.start)) / (s.end - s.start)), 1, words.length - 1);
  commit();
  const b = { id: nextId++, start: t, end: s.end, text: words.slice(k).join(' '), top: s.top };
  s.end = t;
  s.text = words.slice(0, k).join(' ');
  state.segments.splice(findIdx(s.id) + 1, 0, b);
  refreshAll();
}

function mergeSelected() {
  const s = selSeg();
  if (!s) return flash('Önce bir satır seç');
  const i = findIdx(s.id);
  const n = state.segments[i + 1];
  if (!n) return flash('Sonrasında birleştirilecek satır yok');
  commit();
  s.end = Math.max(s.end, n.end);
  s.text = `${s.text.trim()} ${n.text.trim()}`.trim();
  state.segments.splice(i + 1, 1);
  refreshAll();
}

function deleteSelected() {
  const s = selSeg();
  if (!s) return;
  const i = findIdx(s.id);
  commit();
  state.segments.splice(i, 1);
  const nxt = state.segments[i] || state.segments[i - 1];
  state.selected = nxt ? nxt.id : null;
  refreshAll();
}

function addAtPlayhead() {
  const t = nowMs();
  if (state.segments.some((s) => t >= s.start && t < s.end)) return flash('Burada zaten bir satır var — boş bir yere git');
  const i = state.segments.findIndex((s) => s.start > t);
  const next = i >= 0 ? state.segments[i] : null;
  const end = Math.min(t + 1500, next ? next.start : durationMs());
  if (end - t < MIN_LEN) return flash('Burada yeni satıra yer yok');
  commit();
  const seg = { id: nextId++, start: t, end, text: '', top: false };
  state.segments.splice(i >= 0 ? i : state.segments.length, 0, seg);
  state.selected = seg.id;
  refreshAll();
  const row = $('segments').querySelector(`.seg[data-id="${seg.id}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  row?.querySelector('.txt').focus();
}

$('btn-split').addEventListener('click', splitSelected);
$('btn-merge').addEventListener('click', mergeSelected);
$('btn-add').addEventListener('click', addAtPlayhead);
$('btn-del').addEventListener('click', deleteSelected);
$('btn-shift-m').addEventListener('click', () => shiftAll(-100));
$('btn-shift-p').addEventListener('click', () => shiftAll(100));

let flashTimer = null;
function flash(msg) {
  setStatus(msg, 100);
  $('status-bar').parentElement.classList.add('hidden');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (state.busy) return;
    $('status').classList.add('hidden');
    $('status-bar').parentElement.classList.remove('hidden');
  }, 1800);
}

/* =========================================================
   Oynatma
   ========================================================= */
let stopAt = null;
function playSegment(seg) {
  video.currentTime = seg.start / 1000;
  stopAt = seg.end;
  video.play();
}
function togglePlay() {
  if (video.paused) {
    stopAt = null;
    video.play();
  } else video.pause();
}
$('btn-play').addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);

function tick() {
  if (stopAt != null && nowMs() >= stopAt) {
    video.pause();
    stopAt = null;
  }
  followPlayhead();
  updateOverlay();
  drawTimeline();
  if (!video.paused) requestAnimationFrame(tick);
}
video.addEventListener('play', () => {
  $('ico-play').classList.add('hidden');
  $('ico-pause').classList.remove('hidden');
  requestAnimationFrame(tick);
});
video.addEventListener('pause', () => {
  $('ico-play').classList.remove('hidden');
  $('ico-pause').classList.add('hidden');
  updateOverlay();
  drawTimeline();
});
video.addEventListener('seeked', () => {
  updateOverlay();
  drawTimeline();
});
video.addEventListener('loadedmetadata', () => {
  resizeTimeline();
  updateOverlay();
});

let activeId = null;
function updateOverlay() {
  const t = nowMs();
  $('clock').textContent = fmt(t);
  const seg = state.segments.find((s) => t >= s.start && t < s.end);
  $('overlay').textContent = seg ? seg.text : '';
  $('overlay').classList.toggle('top', !!seg?.top);
  const id = seg ? seg.id : null;
  if (id !== activeId) {
    activeId = id;
    $('segments').querySelectorAll('.seg').forEach((r) => r.classList.toggle('active', +r.dataset.id === id));
    if (!video.paused && id != null) {
      const row = $('segments').querySelector(`.seg[data-id="${id}"]`);
      if (row && !row.contains(document.activeElement)) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

/* =========================================================
   Zaman çizelgesi (dalga formu + sürüklenebilir bloklar)
   ========================================================= */
const RULER = 20;
const EDGE = 6;
const tl = { canvas: $('timeline'), view: 0, pps: 0, w: 0, h: 0, drag: null };
const css = getComputedStyle(document.documentElement);
const C = {
  accent: css.getPropertyValue('--accent').trim(),
  danger: css.getPropertyValue('--danger').trim(),
  text: css.getPropertyValue('--text').trim(),
  muted: css.getPropertyValue('--muted').trim(),
  line: css.getPropertyValue('--line').trim(),
};

const xOf = (ms) => (ms / 1000 - tl.view) * tl.pps;
const msAt = (x) => Math.round((tl.view + x / tl.pps) * 1000);
const visibleSec = () => tl.w / tl.pps;
const minPps = () => {
  const d = durationMs() / 1000;
  return d ? tl.w / d : 50;
};

function clampView() {
  if (!tl.w) return;
  const d = durationMs() / 1000;
  if (!tl.pps) tl.pps = Math.max(minPps(), tl.w / 20); // ilk açılışta ~20 sn göster
  tl.pps = clamp(tl.pps, minPps(), 800);
  tl.view = clamp(tl.view, 0, Math.max(0, d - visibleSec()));
}

function resizeTimeline() {
  const r = tl.canvas.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  tl.canvas.width = Math.round(r.width * dpr);
  tl.canvas.height = Math.round(r.height * dpr);
  tl.w = r.width;
  tl.h = r.height;
  clampView();
  drawTimeline();
}
new ResizeObserver(resizeTimeline).observe(tl.canvas);

function zoom(factor, anchorX = xOf(nowMs())) {
  const at = tl.view + clamp(anchorX, 0, tl.w) / tl.pps;
  tl.pps = clamp(tl.pps * factor, minPps(), 800);
  tl.view = at - clamp(anchorX, 0, tl.w) / tl.pps;
  clampView();
  drawTimeline();
}
$('btn-zoom-in').addEventListener('click', () => zoom(1.6));
$('btn-zoom-out').addEventListener('click', () => zoom(1 / 1.6));
$('btn-zoom-fit').addEventListener('click', () => {
  tl.pps = minPps();
  tl.view = 0;
  clampView();
  drawTimeline();
});

function ensureVisible(startMs, endMs) {
  const a = startMs / 1000;
  const b = endMs / 1000;
  const v = visibleSec();
  if (a < tl.view || b > tl.view + v) {
    tl.view = b - a < v * 0.8 ? a - (v - (b - a)) / 2 : a - v * 0.1;
    clampView();
  }
}
function followPlayhead() {
  if (tl.drag) return;
  const t = video.currentTime;
  const v = visibleSec();
  if (t > tl.view + v * 0.92 || t < tl.view) {
    tl.view = t - v * 0.1;
    clampView();
  }
}

function tickStep() {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * tl.pps >= 64) return s;
  return 300;
}

function drawTimeline() {
  const ctx = tl.canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = tl.w;
  const H = tl.h;
  ctx.clearRect(0, 0, W, H);
  if (!W || !state.wave) return;
  // Yeni dosyada pps sıfırlanır; ölçek kurulmadan çizersek cetvel döngüsü sonsuza gider (donma).
  if (!(tl.pps > 0) || !Number.isFinite(tl.pps)) clampView();
  if (!(tl.pps > 0) || !Number.isFinite(tl.pps)) return;

  // cetvel
  const step = tickStep();
  ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.muted;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(W, RULER + 0.5);
  const tEnd = tl.view + visibleSec();
  for (let t = Math.floor(tl.view / step) * step, n = 0; t <= tEnd && n < 500; t += step, n++) {
    const x = Math.round((t - tl.view) * tl.pps) + 0.5;
    ctx.moveTo(x, RULER - 5);
    ctx.lineTo(x, RULER);
    const m = Math.floor(t / 60);
    const s = t % 60;
    const label = step < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
    ctx.fillText(label, x + 4, RULER / 2);
  }
  ctx.stroke();

  // dalga formu
  const { peaks, rate } = state.wave;
  const mid = (RULER + H) / 2;
  const amp = (H - RULER - 10) / 2;
  ctx.fillStyle = 'rgba(236, 235, 232, 0.22)';
  for (let x = 0; x < W; x++) {
    const a = Math.floor((tl.view + x / tl.pps) * rate);
    const b = Math.max(a + 1, Math.floor((tl.view + (x + 1) / tl.pps) * rate));
    let m = 0;
    for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
    const h = Math.max(1, m * amp);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }

  // altyazı blokları
  const top = RULER + 6;
  const bh = H - RULER - 12;
  state.segments.forEach((s, i) => {
    const x1 = xOf(s.start);
    const x2 = xOf(s.end);
    if (x2 < 0 || x1 > W) return;
    const bad = issuesOf(i).some(([k]) => k === 'err');
    const isSel = s.id === state.selected;
    const color = bad ? C.danger : C.accent;
    ctx.globalAlpha = isSel ? 0.34 : 0.16;
    ctx.fillStyle = color;
    roundRect(ctx, x1, top, Math.max(2, x2 - x1), bh, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = isSel ? 2 : 1;
    roundRect(ctx, x1 + 0.5, top + 0.5, Math.max(2, x2 - x1 - 1), bh - 1, 6);
    ctx.stroke();
    if (isSel) {
      // tutamaçlar
      ctx.fillStyle = color;
      ctx.fillRect(x1 + 2, top + bh / 2 - 9, 3, 18);
      ctx.fillRect(x2 - 5, top + bh / 2 - 9, 3, 18);
    }
    if (x2 - x1 > 24) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1 + 8, top, x2 - x1 - 16, bh);
      ctx.clip();
      ctx.fillStyle = C.text;
      ctx.font = '600 11.5px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(s.text || '—', x1 + 9, top + 7);
      ctx.restore();
    }
  });

  // oynatma çizgisi
  const px = Math.round(xOf(nowMs())) + 0.5;
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 6);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hitTest(x, y) {
  if (y < RULER) return null;
  for (const s of state.segments) {
    const x1 = xOf(s.start);
    const x2 = xOf(s.end);
    if (x < x1 - EDGE || x > x2 + EDGE) continue;
    const wide = x2 - x1 > EDGE * 3;
    if (wide && Math.abs(x - x1) <= EDGE) return { seg: s, mode: 'start' };
    if (wide && Math.abs(x - x2) <= EDGE) return { seg: s, mode: 'end' };
    if (x >= x1 && x <= x2) return { seg: s, mode: 'move' };
  }
  return null;
}

const posOf = (e) => {
  const r = tl.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const seekMs = (ms) => {
  video.currentTime = clamp(ms, 0, durationMs()) / 1000;
  updateOverlay();
  drawTimeline();
};

tl.canvas.addEventListener('mousedown', (e) => {
  if (!state.wave) return;
  const { x, y } = posOf(e);
  const h = hitTest(x, y);
  if (!h) {
    tl.drag = { mode: 'scrub' };
    seekMs(msAt(x));
  } else {
    select(h.seg.id, { seek: false });
    tl.drag = { mode: h.mode, seg: h.seg, x0: x, orig: { start: h.seg.start, end: h.seg.end }, before: snapshot(), moved: false };
  }
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', endDrag, { once: true });
});

function onDrag(e) {
  const d = tl.drag;
  if (!d) return;
  const { x } = posOf(e);
  if (d.mode === 'scrub') return seekMs(msAt(x));
  if (Math.abs(x - d.x0) > 2) d.moved = true;
  if (!d.moved) return;
  const s = d.seg;
  const dx = Math.round(((x - d.x0) / tl.pps) * 1000);
  const { lo, hi } = neighbours(s);
  if (d.mode === 'start') {
    s.start = clamp(d.orig.start + dx, Math.min(lo, s.end - MIN_LEN), s.end - MIN_LEN);
    video.currentTime = s.start / 1000;
  } else if (d.mode === 'end') {
    s.end = clamp(d.orig.end + dx, s.start + MIN_LEN, Math.max(hi, s.start + MIN_LEN));
    video.currentTime = s.end / 1000;
  } else {
    const len = d.orig.end - d.orig.start;
    s.start = clamp(d.orig.start + dx, Math.min(lo, d.orig.start), Math.max(hi - len, d.orig.start));
    s.end = s.start + len;
    video.currentTime = s.start / 1000;
  }
  refreshTiming();
}

function endDrag() {
  window.removeEventListener('mousemove', onDrag);
  const d = tl.drag;
  tl.drag = null;
  if (!d || d.mode === 'scrub') return;
  if (d.moved) commit(d.before);
  else seekMs(d.seg.start); // tıklama: satırın başına git
}

tl.canvas.addEventListener('mousemove', (e) => {
  if (tl.drag) return;
  const { x, y } = posOf(e);
  const h = hitTest(x, y);
  tl.canvas.style.cursor = !h ? 'text' : h.mode === 'move' ? 'grab' : 'ew-resize';
});

tl.canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoom(Math.exp(-e.deltaY * 0.01), posOf(e).x);
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      tl.view += delta / tl.pps;
      clampView();
      drawTimeline();
    }
  },
  { passive: false }
);

/* =========================================================
   Klavye
   ========================================================= */
document.addEventListener('keydown', (e) => {
  if ($('work').classList.contains('hidden') || state.busy) return;
  if (isTyping(e.target)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.target.tagName === 'BUTTON' && (e.code === 'Space' || e.key === 'Enter')) e.target.blur();
  const segs = state.segments;
  const s = selSeg();
  const handled = () => e.preventDefault();

  switch (e.code) {
    case 'Space':
      handled();
      return togglePlay();
    case 'KeyI':
      handled();
      return setEdge('start');
    case 'KeyO':
      handled();
      return setEdge('end');
    case 'KeyP':
      handled();
      return s && playSegment(s);
    case 'KeyS':
      if (e.metaKey) return;
      handled();
      return splitSelected();
    case 'KeyM':
      if (e.metaKey) return;
      handled();
      return mergeSelected();
    case 'KeyN':
      if (e.metaKey) return;
      handled();
      return addAtPlayhead();
    case 'Backspace':
    case 'Delete':
      if (!e.metaKey && e.code === 'Backspace') return;
      handled();
      return deleteSelected();
    case 'ArrowLeft':
    case 'ArrowRight': {
      handled();
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      if (e.altKey) return s && nudge(s, dir * (e.shiftKey ? 10 : 100));
      return seekMs(nowMs() + dir * (e.shiftKey ? 100 : 1000));
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!segs.length) return;
      handled();
      const dir = e.code === 'ArrowDown' ? 1 : -1;
      let i = s ? findIdx(s.id) + dir : dir > 0 ? segs.findIndex((x) => x.end > nowMs()) : segs.length - 1;
      i = clamp(i < 0 && dir > 0 ? segs.length - 1 : i, 0, segs.length - 1);
      return select(segs[i].id);
    }
  }
});

/* =========================================================
   Dışa aktarma
   ========================================================= */
const pad = (n, w = 2) => String(n).padStart(w, '0');
function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
function toSrt() {
  return state.segments
    .filter((s) => s.text.trim() && s.end > s.start)
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.top ? '{\\an8}' : ''}${s.text.trim()}\n`)
    .join('\n');
}
function toTxt() {
  return state.segments.map((s) => s.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ') + '\n';
}

async function save(ext, content) {
  const p = await api.save(state.file, ext, content);
  if (!p) return;
  if (ext === 'srt') state.dirty = false;
  const el = $('saved');
  el.innerHTML = '';
  el.append(`Kaydedildi: ${p.split('/').pop()} · `);
  const a = document.createElement('button');
  a.className = 'link';
  a.textContent = 'Finder’da göster';
  a.onclick = () => api.reveal(p);
  el.append(a);
  el.classList.remove('hidden');
}
$('btn-srt').addEventListener('click', () => {
  const bad = state.segments.findIndex((s) => s.end <= s.start);
  if (bad >= 0) {
    select(state.segments[bad].id);
    return flash(`${bad + 1}. satırın süresi yok — önce düzelt`);
  }
  save('srt', toSrt());
});
$('btn-txt').addEventListener('click', () => save('txt', toTxt()));
$('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(toTxt().trim());
  const b = $('btn-copy');
  b.textContent = 'Kopyalandı ✓';
  setTimeout(() => (b.textContent = 'Metni kopyala'), 1400);
});

/* =========================================================
   Başlat
   ========================================================= */
api.onOpenPath((p) => !state.busy && openFile(p));

(async () => {
  renderLang();
  setButtons();
  await checkSetup();
  const p = await api.takePending();
  if (p && !$('setup').classList.contains('hidden')) return;
  if (p) openFile(p);
})();
