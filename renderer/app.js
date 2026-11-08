const $ = (id) => document.getElementById(id);
const api = window.dikte;

const LANG_NAMES = { tr: 'Türkçe', en: 'English', es: 'Español' };
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mp3|m4a|wav|aac|ogg|flac)$/i;

const state = {
  lang: localStorage.getItem('dikte.lang') || 'tr',
  file: null,
  segments: [],
  doneLang: null,
  busy: false,
};

/* ---------- Ekranlar ---------- */
function show(screen) {
  for (const id of ['setup', 'empty', 'work']) $(id).classList.toggle('hidden', id !== screen);
}

/* ---------- Dil seçici ---------- */
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

/* ---------- Kurulum ---------- */
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

/* ---------- Dosya alma ---------- */
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
  openFile(p);
});
$('btn-pick').addEventListener('click', async () => {
  const p = await api.pickVideo();
  if (p) openFile(p);
});
$('btn-new').addEventListener('click', () => {
  if (state.busy) return;
  state.file = null;
  state.segments = [];
  state.doneLang = null;
  $('video').removeAttribute('src');
  $('video').load();
  renderLang();
  show('empty');
});

async function openFile(p) {
  state.file = p;
  state.segments = [];
  state.doneLang = null;
  $('file-name').textContent = p.split('/').pop();
  $('file-name').title = p;
  $('video').src = await api.videoUrl(p);
  hideError();
  renderSegments();
  show('work');
  transcribe();
}

/* ---------- Yazıya dökme ---------- */
function setStatus(text, progress) {
  $('status').classList.remove('hidden');
  $('status-text').textContent = text;
  const bar = $('status-bar').parentElement;
  bar.classList.toggle('indet', progress == null);
  if (progress != null) $('status-bar').style.width = `${progress}%`;
}
api.onStage(({ stage, progress }) => {
  if (stage === 'audio') setStatus('Ses ayrıştırılıyor…', null);
  if (stage === 'whisper') setStatus(`Yazıya dökülüyor (${LANG_NAMES[state.lang]})… %${progress}`, progress);
});

async function transcribe() {
  if (state.busy) return;
  state.busy = true;
  hideError();
  $('saved').classList.add('hidden');
  renderLang();
  setButtons();
  setStatus('Hazırlanıyor…', null);
  const t0 = performance.now();
  try {
    const segs = await api.transcribe(state.file, state.lang);
    state.segments = segs;
    state.doneLang = state.lang;
    renderSegments();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Bitti · ${segs.length} satır · ${secs} sn`, 100);
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
$('btn-relang').addEventListener('click', transcribe);

function showError(msg) {
  $('error').textContent = msg;
  $('error').classList.remove('hidden');
}
function hideError() {
  $('error').classList.add('hidden');
}

/* ---------- Altyazı listesi ---------- */
const fmtShort = (ms) => {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

function renderSegments() {
  const list = $('segments');
  list.innerHTML = '';
  $('seg-count').textContent = state.segments.length ? `${state.segments.length} satır` : '';
  if (!state.segments.length) {
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = state.busy || state.file ? 'Altyazılar burada görünecek.' : '';
    list.appendChild(p);
    return;
  }
  state.segments.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'seg';
    row.dataset.i = i;

    const time = document.createElement('button');
    time.className = 'time';
    time.textContent = fmtShort(seg.start);
    time.title = 'Buraya git';
    time.addEventListener('click', () => {
      const v = $('video');
      v.currentTime = seg.start / 1000 + 0.01;
      v.play();
    });

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.contentEditable = 'plaintext-only';
    txt.spellcheck = false;
    txt.textContent = seg.text;
    txt.addEventListener('input', () => {
      seg.text = txt.textContent;
      updateOverlay();
    });

    row.append(time, txt);
    list.appendChild(row);
  });
  setButtons();
}

function setButtons() {
  const has = state.segments.length > 0 && !state.busy;
  ['btn-copy', 'btn-txt', 'btn-srt'].forEach((id) => ($(id).disabled = !has));
  $('btn-new').disabled = state.busy;
}

/* ---------- Video üstü altyazı ---------- */
let activeIdx = -1;
function updateOverlay() {
  const t = $('video').currentTime * 1000;
  const idx = state.segments.findIndex((s) => t >= s.start && t < s.end);
  $('overlay').textContent = idx >= 0 ? state.segments[idx].text : '';
  if (idx !== activeIdx) {
    document.querySelector('.seg.active')?.classList.remove('active');
    const row = document.querySelector(`.seg[data-i="${idx}"]`);
    if (row) {
      row.classList.add('active');
      if (!row.contains(document.activeElement)) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    activeIdx = idx;
  }
}
$('video').addEventListener('timeupdate', updateOverlay);
$('video').addEventListener('seeked', updateOverlay);

/* ---------- Dışa aktarma ---------- */
const pad = (n, w = 2) => String(n).padStart(w, '0');
function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
function toSrt() {
  return (
    state.segments
      .filter((s) => s.text.trim())
      .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`)
      .join('\n')
  );
}
function toTxt() {
  return state.segments.map((s) => s.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ') + '\n';
}

async function save(ext, content) {
  const p = await api.save(state.file, ext, content);
  if (!p) return;
  const el = $('saved');
  el.innerHTML = '';
  const name = p.split('/').pop();
  el.append(`Kaydedildi: ${name} · `);
  const a = document.createElement('button');
  a.className = 'link';
  a.textContent = 'Finder’da göster';
  a.onclick = () => api.reveal(p);
  el.append(a);
  el.classList.remove('hidden');
}
$('btn-srt').addEventListener('click', () => save('srt', toSrt()));
$('btn-txt').addEventListener('click', () => save('txt', toTxt()));
$('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(toTxt().trim());
  const b = $('btn-copy');
  b.textContent = 'Kopyalandı ✓';
  setTimeout(() => (b.textContent = 'Metni kopyala'), 1400);
});

/* ---------- Başlat ---------- */
api.onOpenPath((p) => !state.busy && openFile(p));

(async () => {
  renderLang();
  await checkSetup();
  const p = await api.takePending();
  if (p && !$('setup').classList.contains('hidden')) return;
  if (p) openFile(p);
})();
