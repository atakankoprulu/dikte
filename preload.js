const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dikte', {
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  downloadModel: () => ipcRenderer.invoke('model:download'),
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  videoUrl: (p) => ipcRenderer.invoke('video:url', p),
  transcribe: (file, lang) => ipcRenderer.invoke('transcribe', { file, lang }),
  cancel: () => ipcRenderer.invoke('transcribe:cancel'),
  save: (videoPath, ext, content) => ipcRenderer.invoke('export:save', { videoPath, ext, content }),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  onStage: (cb) => ipcRenderer.on('transcribe:stage', (_e, d) => cb(d)),
  takePending: () => ipcRenderer.invoke('pending:take'),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  onEdit: (cb) => ipcRenderer.on('edit', (_e, what) => cb(what)),
  onModelProgress: (cb) => ipcRenderer.on('model:progress', (_e, d) => cb(d)),
});
