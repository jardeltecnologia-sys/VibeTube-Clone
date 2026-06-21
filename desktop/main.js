'use strict';

// SpeedVox Desktop (Electron). Boots the bundled Node server in-process, waits
// for it to be ready, then opens a window pointing at it. Self-contained: no
// separate backend hosting is needed.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

const PORT = process.env.SPEEDVOX_PORT || '3017';
process.env.PORT = PORT;

// Persist data/uploads in the OS user-data folder (writable when packaged).
const userData = app.getPath('userData');
process.env.SPEEDVOX_DATA_DIR = process.env.SPEEDVOX_DATA_DIR || path.join(userData, 'data');
process.env.SPEEDVOX_UPLOAD_DIR = process.env.SPEEDVOX_UPLOAD_DIR || path.join(userData, 'uploads');

// Resolve the server entry both in dev (repo) and when packaged.
function serverEntry() {
  const candidates = [
    path.join(__dirname, '..', 'server', 'index.js'),
    path.join(__dirname, 'app', 'server', 'index.js'),
    path.join(process.resourcesPath || '', 'app', 'server', 'index.js'),
  ];
  for (const c of candidates) { try { require.resolve(c); return c; } catch { /* next */ } }
  return candidates[0];
}

let win;

function waitForServer(cb, tries = 0) {
  http
    .get(`http://127.0.0.1:${PORT}/api/health`, (res) => { res.resume(); cb(); })
    .on('error', () => {
      if (tries > 75) cb(new Error('servidor não respondeu a tempo'));
      else setTimeout(() => waitForServer(cb, tries + 1), 200);
    });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#0b141a',
    title: 'SpeedVox',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  if (win.removeMenu) win.removeMenu();
  win.loadURL(`http://127.0.0.1:${PORT}`);
  // Open external links (e.g. uploaded files) in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  try { require(serverEntry()); } catch (e) { console.error('Falha ao iniciar o servidor:', e); }
  waitForServer((err) => {
    if (err) console.error(err.message);
    createWindow();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
