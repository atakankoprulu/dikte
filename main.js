const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Whisper modeli + konuşma algılama (VAD) modeli. VAD, altyazıların sessizliğe taşmasını engeller.
const MODELS = [
  { name: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' },
  { name: 'ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' },
];
const LANGS = new Set(['tr', 'en', 'es']);

// GUI'den açılan macOS uygulamaları shell PATH'ini görmez; Homebrew yollarını elle ekle.
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function findBinary(name) {
  const dirs = [...EXTRA_PATHS, ...(process.env.PATH || '').split(':')];
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function modelDir() {
  return path.join(app.getPath('appData'), 'Dikte', 'models');
}

function modelPath(i = 0) {
  return path.join(modelDir(), MODELS[i].name);
}

function missingModels() {
  return MODELS.filter((m) => !fs.existsSync(path.join(modelDir(), m.name)));
}

let win = null;
let pendingOpen = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a)) || null;
if (pendingOpen) pendingOpen = path.resolve(pendingOpen);

// Dock ikonuna sürükleme / "Birlikte Aç"
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) send('open-path', p);
  else pendingOpen = p;
});
let running = []; // aktif alt süreçler (iptal için)
let cancelled = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // pencere arkadayken oynatma/çizim durmasın
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('pending:take', () => {
  const p = pendingOpen;
  pendingOpen = null;
  return p;
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function run(cmd, args, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    running.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      onStderr && onStderr(s);
    });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      running = running.filter((c) => c !== child);
      if (cancelled) return reject(new Error('İptal edildi'));
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} hata verdi (kod ${code}):\n${stderr.slice(-1500)}`));
    });
  });
}

// 16 kHz mono 16-bit WAV'dan dalga formu tepe değerleri (saniyede `rate` adet, 0..1)
function computePeaks(file, rate = 100) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(len, buf.length - dataOff);
      break;
    }
    off += 8 + len + (len & 1);
  }
  if (dataOff < 0) return { peaks: [], rate, duration: 0 };
  const n = Math.floor(dataLen / 2);
  const step = 16000 / rate;
  const peaks = new Array(Math.ceil(n / step));
  let max = 1;
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    const a = Math.floor(i * step);
    const b = Math.min(n, Math.floor((i + 1) * step));
    for (let j = a; j < b; j++) {
      const v = Math.abs(buf.readInt16LE(dataOff + j * 2));
      if (v > m) m = v;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  return { peaks: peaks.map((v) => Math.round((v / max) * 1000) / 1000), rate, duration: n / 16000 };
}

// Whisper bitişleri son hecenin biraz önünde keser; altyazıyı biraz uzat (sonrakine çakışmadan),
// çok kısa satırlara da okunabilecek kadar süre ver.
function polishTiming(segs, durationMs) {
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    const limit = next ? next.start - 40 : durationMs;
    s.end = Math.max(s.end, Math.min(s.end + 200, limit));
    if (s.end - s.start < 700) s.end = Math.max(s.end, Math.min(s.start + 700, limit));
  });
  return segs;
}

function parseSrt(text) {
  const toMs = (t) => {
    const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
  };
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim().split('\n'))
    .filter((lines) => lines.length >= 2 && lines[1].includes('-->'))
    .map((lines) => {
      const [a, b] = lines[1].split('-->');
      return { start: toMs(a), end: toMs(b), text: lines.slice(2).join('\n').trim() };
    })
    .filter((s) => s.text.length > 0);
}

ipcMain.handle('setup:check', () => ({
  ffmpeg: !!findBinary('ffmpeg'),
  whisper: !!findBinary('whisper-cli'),
  model: missingModels().length === 0,
}));

ipcMain.handle('model:download', async () => {
  fs.mkdirSync(modelDir(), { recursive: true });
  for (const m of missingModels()) {
    const dest = path.join(modelDir(), m.name);
    const tmp = dest + '.part';
    const res = await fetch(m.url);
    if (!res.ok || !res.body) throw new Error(`${m.name} indirilemedi (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    let lastSent = 0;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastSent > 150) {
        lastSent = now;
        send('model:progress', { got, total });
      }
    }
    await new Promise((r) => out.end(r));
    fs.renameSync(tmp, dest);
    send('model:progress', { got: total, total });
  }
  return true;
});

ipcMain.handle('video:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Video / Ses', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('video:url', (_e, p) => pathToFileURL(p).href);

ipcMain.handle('transcribe', async (_e, { file, lang }) => {
  if (!LANGS.has(lang)) throw new Error('Geçersiz dil');
  const ffmpeg = findBinary('ffmpeg');
  const whisper = findBinary('whisper-cli');
  if (!ffmpeg || !whisper) throw new Error('ffmpeg veya whisper-cli bulunamadı');
  if (missingModels().length) throw new Error('Model yok');

  cancelled = false;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dikte-'));
  const wav = path.join(work, 'audio.wav');
  const outBase = path.join(work, 'out');

  try {
    send('transcribe:stage', { stage: 'audio' });
    await run(ffmpeg, ['-nostdin', '-y', '-i', file, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);

    send('transcribe:stage', { stage: 'whisper', progress: 0 });
    const threads = Math.max(2, Math.min(8, os.cpus().length));
    await run(
      whisper,
      ['-m', modelPath(0), '-f', wav, '-l', lang, '-t', String(threads), '-osrt', '-of', outBase, '-ml', '42', '-sow', '-pp',
        '--vad', '-vm', modelPath(1)],
      (chunk) => {
        const matches = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)];
        if (matches.length) send('transcribe:stage', { stage: 'whisper', progress: +matches.at(-1)[1] });
      }
    );

    const srt = fs.readFileSync(outBase + '.srt', 'utf8');
    const wave = computePeaks(wav);
    return { segments: polishTiming(parseSrt(srt), wave.duration * 1000), wave };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

ipcMain.handle('transcribe:cancel', () => {
  cancelled = true;
  for (const c of running) c.kill('SIGTERM');
  running = [];
});

ipcMain.handle('export:save', async (_e, { videoPath, ext, content }) => {
  const parsed = path.parse(videoPath);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(parsed.dir, `${parsed.name}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'Düzen',
      submenu: [
        // Geri al/yinele renderer'a gider: yazı alanındaysa metni, değilse altyazı zamanlamasını geri alır
        { label: 'Geri Al', accelerator: 'CmdOrCtrl+Z', click: () => send('edit', 'undo') },
        { label: 'Yinele', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('edit', 'redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Kes' },
        { role: 'copy', label: 'Kopyala' },
        { role: 'paste', label: 'Yapıştır' },
        { role: 'selectAll', label: 'Tümünü Seç' },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [{ role: 'togglefullscreen', label: 'Tam Ekran' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])],
    },
    { role: 'windowMenu', label: 'Pencere' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
