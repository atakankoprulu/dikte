const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
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

function modelPath() {
  return path.join(modelDir(), MODEL_NAME);
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
  model: fs.existsSync(modelPath()),
}));

ipcMain.handle('model:download', async () => {
  fs.mkdirSync(modelDir(), { recursive: true });
  const tmp = modelPath() + '.part';
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model indirilemedi (HTTP ${res.status})`);
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
  fs.renameSync(tmp, modelPath());
  send('model:progress', { got: total, total });
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
  if (!fs.existsSync(modelPath())) throw new Error('Model yok');

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
      ['-m', modelPath(), '-f', wav, '-l', lang, '-t', String(threads), '-osrt', '-of', outBase, '-ml', '42', '-sow', '-pp'],
      (chunk) => {
        const matches = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)];
        if (matches.length) send('transcribe:stage', { stage: 'whisper', progress: +matches.at(-1)[1] });
      }
    );

    const srt = fs.readFileSync(outBase + '.srt', 'utf8');
    return parseSrt(srt);
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
