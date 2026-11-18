'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { streamChat, listModels } = require('./providers');
const { extractFile, extractBuffer } = require('./files');

/* ---------------- 数据目录（可自定义到任意磁盘） ----------------
   指针文件放在 exe 同级目录（不依赖 userData，避免先有鸡还是先有蛋），
   里面记着用户自定义的数据目录；没有指针文件时用 exe 同级 LumoData。 */

const DEFAULT_DIR_NAME = 'LumoData';
const POINTER_NAME = 'lumo-data-dir.txt';

function exeDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    return path.dirname(process.execPath);
  } catch (_) {
    return null;
  }
}

function pointerFile() {
  const d = exeDir();
  return d ? path.join(d, POINTER_NAME) : null;
}

function readPointer() {
  try {
    const p = pointerFile();
    if (!p) return '';
    const raw = fs.readFileSync(p, 'utf-8').trim();
    return raw || '';
  } catch (_) {
    return '';
  }
}

function writePointer(dir) {
  const p = pointerFile();
  if (!p) throw new Error('程序目录不可写，无法保存目录设置');
  fs.writeFileSync(p, dir, 'utf-8');
}

function clearPointer() {
  try {
    const p = pointerFile();
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

function ensureWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
  return dir;
}

function resolveDataDir() {
  const custom = readPointer();
  if (custom) {
    try {
      return ensureWritable(custom);
    } catch (_) {
      /* 自定义目录不可用（磁盘被拔掉 / 无权限）时退回默认，不阻塞启动 */
    }
  }
  const base = exeDir();
  if (base) {
    try {
      return ensureWritable(path.join(base, DEFAULT_DIR_NAME));
    } catch (_) {
      /* ignore */
    }
  }
  return '';
}

const resolvedDataDir = resolveDataDir();
/* 运行期可切换：activeDataDir 变了以后，所有读写立即走新目录，不必重启 */
let activeDataDir = resolvedDataDir;
if (resolvedDataDir) {
  try {
    app.setPath('userData', resolvedDataDir);
  } catch (_) {
    /* ignore */
  }
}

/* 把旧目录里的聊天数据搬到新目录（只搬 lumo-data.json，缓存可重建） */
function migrateData(fromDir, toDir) {
  if (!fromDir || !toDir) return false;
  if (path.resolve(fromDir) === path.resolve(toDir)) return false;
  try {
    ensureWritable(toDir);
    const src = path.join(fromDir, 'lumo-data.json');
    const dst = path.join(toDir, 'lumo-data.json');
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function currentDataDir() {
  if (activeDataDir) return activeDataDir;
  const base = exeDir();
  return base ? path.join(base, DEFAULT_DIR_NAME) : '';
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
const controllers = new Map();

const dataFile = () => path.join(currentDataDir() || app.getPath('userData'), 'lumo-data.json');

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 580,
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#4b4b52', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // ready-to-show 万一不触发（显卡/渲染异常），3 秒后强制显示，避免“进程在但没窗口”
  const showOnce = () => {
    if (win && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', showOnce);
  setTimeout(showOnce, 3000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

app.on('second-instance', () => {
  // 没有窗口就重建：否则用户再双击也不会有任何反应
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- 本地存储 ---------------- */

ipcMain.handle('data:load', async () => {
  try {
    const raw = await fs.promises.readFile(dataFile(), 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
});

ipcMain.handle('data:save', async (_e, data) => {
  const file = dataFile();
  const tmp = file + '.tmp';
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf-8');
  await fs.promises.rename(tmp, file);
  return true;
});

/* ---------------- 聊天流 ---------------- */

function friendlyError(err) {
  const raw = String((err && err.message) || err || '未知错误');
  if (err && err.name === 'AbortError') return '已停止';
  if (/HTTP 401|HTTP 403|invalid_api_key|authentication/i.test(raw))
    return '密钥无效或没有权限（401/403）。请到设置里检查 API Key。';
  if (/HTTP 404/i.test(raw)) return `接口地址不对（404）。请检查 Base URL 是否包含正确的版本路径，例如 /v1。\n${raw}`;
  if (/HTTP 429|rate.?limit/i.test(raw)) return `请求过于频繁或额度用尽（429）。\n${raw}`;
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(raw))
    return `无法连接到该服务，请检查网络或地址是否正确。\n${raw}`;
  if (/HTTP 400/i.test(raw)) return `请求参数被拒绝（400）。模型名称可能不对，或该模型不支持当前参数。\n${raw}`;
  return raw;
}

ipcMain.handle('chat:start', async (event, payload) => {
  const requestId = payload && payload.requestId;
  if (!requestId) return { ok: false, error: '缺少请求 ID' };

  const ac = new AbortController();
  controllers.set(requestId, ac);
  const sender = event.sender;
  const send = (obj) => {
    if (!sender.isDestroyed()) sender.send('chat:event', Object.assign({ requestId }, obj));
  };

  try {
    await streamChat(payload, {
      signal: ac.signal,
      onDelta: (text) => send({ type: 'delta', text }),
      onThinking: (text) => send({ type: 'thinking', text }),
      onUsage: (usage) => send({ type: 'usage', usage }),
    });
    send({ type: 'done' });
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      send({ type: 'aborted' });
      return { ok: false, aborted: true };
    }
    send({ type: 'error', message: friendlyError(err) });
    return { ok: false, error: friendlyError(err) };
  } finally {
    controllers.delete(requestId);
  }
});

ipcMain.handle('chat:abort', (_e, requestId) => {
  const ac = controllers.get(requestId);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
});

ipcMain.handle('models:list', async (_e, provider) => {
  try {
    const models = await listModels(provider);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
});

/* ---------------- 文件上下文 ---------------- */

const FILE_FILTERS = [
  { name: '文档', extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'json', 'log', 'xml', 'yml', 'yaml', 'ini'] },
  { name: '代码', extensions: ['js', 'mjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'sql', 'css', 'scss', 'html', 'vue', 'kt', 'swift', 'lua', 'r', 'toml'] },
  { name: '所有文件', extensions: ['*'] },
];

ipcMain.handle('file:pick', async (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(w, {
    title: '选择要作为上下文发送的文件',
    properties: ['openFile', 'multiSelections'],
    filters: FILE_FILTERS,
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, files: [] };

  const files = [];
  const errors = [];
  for (const p of result.filePaths) {
    try {
      files.push(await extractFile(p));
    } catch (err) {
      errors.push(`${path.basename(p)}：${(err && err.message) || err}`);
    }
  }
  return { ok: true, files, errors };
});

ipcMain.handle('file:extract', async (_e, payload) => {
  try {
    const name = String((payload && payload.name) || 'file');
    const raw = payload && payload.buffer;
    if (!raw) return { ok: false, error: '没有读到文件内容' };
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length > 80 * 1024 * 1024) return { ok: false, error: '文件超过 80MB' };
    return { ok: true, file: extractBuffer(name, buf) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------------- 数据目录切换 ---------------- */

ipcMain.handle('data:choose-dir', async (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(w, {
    title: '选择数据保存目录（可放到任意磁盘）',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '就用这里',
  });
  if (res.canceled || !res.filePaths.length) return { ok: true, canceled: true };

  let target = res.filePaths[0];
  if (path.basename(target).toLowerCase() !== DEFAULT_DIR_NAME.toLowerCase()) {
    target = path.join(target, DEFAULT_DIR_NAME);
  }
  try {
    ensureWritable(target);
    const moved = migrateData(currentDataDir(), target);
    writePointer(target);
    activeDataDir = target;
    return { ok: true, dir: target, moved };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('data:reset-dir', async () => {
  const base = exeDir();
  const target = base ? path.join(base, DEFAULT_DIR_NAME) : '';
  if (!target) return { ok: false, error: '取不到程序目录' };
  try {
    ensureWritable(target);
    const moved = migrateData(currentDataDir(), target);
    clearPointer();
    activeDataDir = target;
    return { ok: true, dir: target, moved };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('data:open-dir', async () => {
  const dir = currentDataDir();
  if (!dir) return { ok: false };
  try {
    await shell.openPath(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------------- 窗口控制 ---------------- */

ipcMain.handle('win:set-overlay', (e, { color, symbolColor }) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && process.platform !== 'darwin' && w.setTitleBarOverlay) {
    try {
      w.setTitleBarOverlay({ color, symbolColor, height: 44 });
    } catch (_) {
      /* ignore */
    }
  }
});

ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  dataPath: dataFile(),
  dataDir: currentDataDir(),
  customDataDir: !!readPointer(),
}));
