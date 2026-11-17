'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apkstartSplash', {
  version: () => ipcRenderer.invoke('splash:version'),
  isFirstRun: () => ipcRenderer.invoke('splash:isFirstRun'),
  // 运行组件是随包带来của（完整版 / 商店 MSIX 版）还是Cần联网下载（轻量版）。
  // 开机动画据此换掉「下载 xx MB」那套文案 —— 明明已经内置了还写「Đang tải xuống」，
  // Dùng户会以为装完还要再下一遍。
  bundled: () => ipcRenderer.invoke('splash:bundled'),
  onProgress: (cb) => { ipcRenderer.on('splash:progress', (_e, p) => cb(p)); },
  onDone: (cb) => { ipcRenderer.on('splash:done', () => cb()); },
  close: () => ipcRenderer.send('splash:close'),
});
