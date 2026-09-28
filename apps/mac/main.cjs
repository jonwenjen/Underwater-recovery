/**
 * Underwater Recovery Studio for macOS — the web app in Electron (Chromium),
 * so WebGL2, WebCodecs video export, WebGPU and the File System Access API
 * behave exactly as in Chrome.
 *
 * The production build (APP_BUILD=1, relative paths) is copied to ./web and
 * served from a private app:// origin rather than file://: module scripts,
 * fetch() of the AI model and secure-context APIs all need a real origin.
 */
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, 'web');
const ORIGIN = 'app://studio';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.onnx': 'application/octet-stream',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

async function serve(req) {
  let rel = decodeURIComponent(new URL(req.url).pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
  const res = await net.fetch(pathToFileURL(file).toString());
  if (!res.ok) return new Response('not found', { status: 404 });
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' },
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 820,
    minHeight: 600,
    title: 'Underwater Recovery Studio',
    backgroundColor: '#06121f',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // links (README, sources) open in the default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.loadURL(`${ORIGIN}/`);
}

app.whenReady().then(() => {
  protocol.handle('app', serve);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ]),
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
