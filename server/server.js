#!/usr/bin/env node
'use strict';

const express = require('express');
const multer = require('multer');
const mime = require('mime-types');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, exec } = require('child_process');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3359', 10);
const HOST = '127.0.0.1';
const ROOT_DIR = '/';

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeout || 30000,
      maxBuffer: 20 * 1024 * 1024,
      cwd: opts.cwd
    }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

const app = express();
app.use(express.json({ limit: '50mb' }));

function sendErr(res, msg, status) {
  return res.status(status || 400).json({ success: false, error: msg });
}

function toRel(abs) {
  if (abs === ROOT_DIR) return '';
  return path.relative(ROOT_DIR, abs).split(path.sep).join('/');
}

function safeResolve(p) {
  const abs = path.resolve(ROOT_DIR, String(p || ''));
  // Allow any path under root (since root is /)
  return abs;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function exists(p) {
  try { fs.statSync(p); return true; } catch (e) { return false; }
}

async function hasChildren(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const name of entries) {
      if (name.isDirectory()) return true;
    }
  } catch (e) {}
  return false;
}

function streamFile(file, res) {
  const st = fs.statSync(file);
  res.setHeader('Content-Type', mime.lookup(file) || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Browse API ──
app.get('/api/browse', async (req, res) => {
  try {
    const dir = safeResolve(req.query.path);
    if (!isDir(dir)) return sendErr(res, 'フォルダではありません');
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let st;
      try { st = await fs.promises.stat(full); } catch (e) { continue; }
      let owner = 'unknown', group = 'unknown';
      try {
        const statResult = await sh('stat', ['-c', '%U:%G', full], { timeout: 5000 });
        const parts = statResult.stdout.trim().split(':');
        owner = parts[0] || 'unknown';
        group = parts[1] || 'unknown';
      } catch (e) {}
      items.push({
        name: ent.name,
        path: toRel(full),
        isDirectory: ent.isDirectory(),
        size: ent.isDirectory() ? 0 : st.size,
        extension: ent.isDirectory() ? '' : path.extname(ent.name).toLowerCase(),
        modified: st.mtime.toISOString(),
        hasChildren: ent.isDirectory() ? await hasChildren(full) : false,
        owner,
        group,
        permissions: (st.mode & 0o777).toString(8)
      });
    }
    res.json({ success: true, items });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Tree API ──
app.get('/api/tree', async (req, res) => {
  try {
    const dir = safeResolve(req.query.path);
    if (!isDir(dir)) return sendErr(res, 'フォルダではありません');
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      items.push({ name: ent.name, path: toRel(full), hasChildren: await hasChildren(full) });
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    res.json({ success: true, items });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Thumbnail ──
app.get('/api/thumbnail', (req, res) => {
  try {
    const file = safeResolve(req.query.path);
    const type = mime.lookup(file) || 'application/octet-stream';
    if (!type.startsWith('image/')) return sendErr(res, '画像ではありません', 415);
    res.setHeader('Content-Type', type);
    fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── View ──
app.get('/api/view', (req, res) => {
  try {
    const file = safeResolve(req.query.path);
    if (isDir(file)) return sendErr(res, 'フォルダです');
    res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(path.basename(file)) + '"');
    streamFile(file, res);
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Download ──
app.get('/api/download', (req, res) => {
  try {
    const file = safeResolve(req.query.path);
    if (isDir(file)) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(path.basename(file)) + '.zip"');
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', () => res.status(500).end());
      archive.pipe(res);
      archive.directory(file, path.basename(file));
      archive.finalize();
      return;
    }
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(path.basename(file)) + '"');
    streamFile(file, res);
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Batch Download ──
app.post('/api/download-batch', (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="download.zip"');
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);
  const seen = new Set();
  for (const p of paths) {
    try {
      const abs = safeResolve(p);
      const name = path.basename(abs);
      if (seen.has(name)) continue;
      seen.add(name);
      if (isDir(abs)) archive.directory(abs, name);
      else archive.file(abs, { name });
    } catch (e) {}
  }
  archive.finalize();
});

// ── Move ──
app.post('/api/move', (req, res) => {
  try {
    const src = safeResolve(req.body.sourcePath);
    const destDir = safeResolve(req.body.destPath);
    if (!isDir(destDir)) return sendErr(res, '移動先がフォルダではありません');
    const dest = path.join(destDir, path.basename(src));
    if (src !== dest) fs.renameSync(src, dest);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Copy ──
app.post('/api/copy', (req, res) => {
  try {
    const src = safeResolve(req.body.sourcePath);
    const destDir = safeResolve(req.body.destPath);
    if (!isDir(destDir)) return sendErr(res, 'コピー先がフォルダではありません');
    const dest = path.join(destDir, path.basename(src));
    if (src === dest) return sendErr(res, '同じパスです');
    if (exists(dest)) return sendErr(res, '同じ名前のファイルが既に存在します');
    fs.cpSync(src, dest, { recursive: true });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Batch Move ──
app.post('/api/move-batch', (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  let destDir;
  try { destDir = safeResolve(req.body.destPath); } catch (e) { return sendErr(res, e.message); }
  const errors = [];
  let moved = 0;
  for (const p of paths) {
    try {
      const src = safeResolve(p);
      const dest = path.join(destDir, path.basename(src));
      if (src === dest) continue;
      fs.renameSync(src, dest);
      moved++;
    } catch (e) {
      errors.push({ path: p, error: e.message });
    }
  }
  res.json({ success: true, moved, errors });
});

// ── Batch Copy ──
app.post('/api/copy-batch', (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  let destDir;
  try { destDir = safeResolve(req.body.destPath); } catch (e) { return sendErr(res, e.message); }
  const errors = [];
  let copied = 0;
  for (const p of paths) {
    try {
      const src = safeResolve(p);
      const dest = path.join(destDir, path.basename(src));
      if (src === dest) continue;
      fs.cpSync(src, dest, { recursive: true });
      copied++;
    } catch (e) {
      errors.push({ path: p, error: e.message });
    }
  }
  res.json({ success: true, copied, errors });
});

// ── Delete ──
app.post('/api/delete', (req, res) => {
  try {
    const abs = safeResolve(req.body.path);
    if (abs === ROOT_DIR) return sendErr(res, 'ルートディレクトリは削除できません');
    fs.rmSync(abs, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Batch Delete ──
app.post('/api/delete-batch', (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  for (const p of paths) {
    try {
      const abs = safeResolve(p);
      if (abs !== ROOT_DIR) fs.rmSync(abs, { recursive: true, force: true });
    } catch (e) {}
  }
  res.json({ success: true });
});

// ── Rename ──
app.post('/api/rename', (req, res) => {
  try {
    const oldAbs = safeResolve(req.body.oldPath);
    const newName = String(req.body.newName || '').trim();
    if (!newName || newName.includes('/') || newName.includes('\\')) return sendErr(res, '名前が不正です');
    const newAbs = path.join(path.dirname(oldAbs), newName);
    if (fs.existsSync(newAbs)) return sendErr(res, '同じ名前のファイルが存在します');
    fs.renameSync(oldAbs, newAbs);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Mkdir ──
app.post('/api/mkdir', (req, res) => {
  try {
    const dir = safeResolve(req.body.path);
    const name = String(req.body.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\')) return sendErr(res, '名前が不正です');
    const target = path.join(dir, name);
    if (fs.existsSync(target)) return sendErr(res, '同じ名前のフォルダが存在します');
    fs.mkdirSync(target);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Create File ──
app.post('/api/createfile', (req, res) => {
  try {
    const dir = safeResolve(req.body.path);
    const name = String(req.body.name || '').trim();
    const type = String(req.body.type || '.txt');
    if (!name || name.includes('/') || name.includes('\\')) return sendErr(res, '名前が不正です');
    const ext = type.startsWith('.') ? type : '.' + type;
    const target = path.join(dir, name + ext);
    if (fs.existsSync(target)) return sendErr(res, '同じ名前のファイルが存在します');
    fs.writeFileSync(target, '');
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Upload ──
const uploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, safeResolve(req.query.path)); } catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      cb(null, path.basename(file.originalname).replace(/[\\/:*?"<>|]/g, '_'));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB
});

app.post('/api/upload', (req, res) => {
  uploader.array('files')(req, res, (err) => {
    if (err) return sendErr(res, err.message);
    res.json({ success: true });
  });
});

// ── Info ──
app.get('/api/info', async (req, res) => {
  try {
    const abs = safeResolve(req.query.path);
    const st = fs.statSync(abs);
    let owner = 'unknown', group = 'unknown';
    try {
      const result = await sh('stat', ['-c', '%U:%G', abs], { timeout: 5000 });
      const parts = result.stdout.trim().split(':');
      owner = parts[0] || 'unknown';
      group = parts[1] || 'unknown';
    } catch (e) {}
    res.json({ success: true, info: {
      name: path.basename(abs),
      path: toRel(abs),
      absPath: abs,
      isDirectory: st.isDirectory(),
      size: st.size,
      modified: st.mtime.toISOString(),
      created: st.birthtime.toISOString(),
      permissions: '0' + (st.mode & 0o777).toString(8),
      owner,
      group
    }});
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── Permissions ──
app.post('/api/chmod', async (req, res) => {
  try {
    const abs = safeResolve(req.body.path);
    const perms = String(req.body.permissions || '').trim();
    if (!/^[0-7]{3,4}$/.test(perms)) return sendErr(res, '権限の形式が不正です');
    await sh('chmod', [perms, abs], { timeout: 10000 });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

app.post('/api/chown', async (req, res) => {
  try {
    const abs = safeResolve(req.body.path);
    const owner = String(req.body.owner || '').trim();
    const group = String(req.body.group || '').trim();
    if (!owner && !group) return sendErr(res, '所有者またはグループを指定してください');
    const args = [];
    if (owner && group) args.push(`${owner}:${group}`);
    else if (owner) args.push(owner);
    else args.push(`:${group}`);
    args.push(abs);
    await sh('chown', args, { timeout: 10000 });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e.message, e.status || 400);
  }
});

// ── List users/groups for permission editing ──
app.get('/api/users', async (req, res) => {
  try {
    const result = await sh('getent', ['passwd'], { timeout: 5000 });
    const users = result.stdout.split('\n').filter(Boolean).map(line => {
      const parts = line.split(':');
      return { name: parts[0], uid: parseInt(parts[2]), gid: parseInt(parts[3]) };
    }).filter(u => u.uid >= 0 && u.uid < 65534);
    res.json({ success: true, users });
  } catch (e) {
    res.json({ success: true, users: [] });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const result = await sh('getent', ['group'], { timeout: 5000 });
    const groups = result.stdout.split('\n').filter(Boolean).map(line => {
      const parts = line.split(':');
      return { name: parts[0], gid: parseInt(parts[2]) };
    }).filter(g => g.gid >= 0 && g.gid < 65534);
    res.json({ success: true, groups });
  } catch (e) {
    res.json({ success: true, groups: [] });
  }
});

// ── Current user info ──
app.get('/api/user', async (req, res) => {
  try {
    const whoami = await sh('whoami', [], { timeout: 5000 });
    const currentUser = whoami.stdout.trim();
    // Get users with login shells
    const passwd = await sh('getent', ['passwd'], { timeout: 5000 });
    const users = passwd.stdout.split('\n').filter(Boolean).map(line => {
      const parts = line.split(':');
      return { name: parts[0], uid: parseInt(parts[2]) };
    }).filter(u => u.uid >= 0 && u.uid < 65534 && u.name !== 'nobody');
    res.json({ success: true, currentUser, users });
  } catch (e) {
    res.json({ success: true, currentUser: 'root', users: [{ name: 'root', uid: 0 }] });
  }
});

// ── WebSocket Terminal ──
const WebSocket = require('ws');
const os = require('os');
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/terminal' });

// Detect default non-root user with login shell
let TERM_USER = null;
let IS_ROOT = process.getuid && process.getuid() === 0;
try {
  const { execSync } = require('child_process');
  const passwd = execSync('getent passwd', { timeout: 3000 }).toString();
  const candidates = passwd.split('\n').filter(Boolean)
    .map(l => l.split(':'))
    .filter(p => parseInt(p[2]) >= 1000 && parseInt(p[2]) < 65534 && p[6] && (p[6].includes('bash') || p[6].includes('sh')));
  if (candidates.length > 0) TERM_USER = candidates[0][0];
} catch (e) {}
console.log(`[servEX] Default terminal user: ${TERM_USER || 'root'}`);

function userHomeOf(user) {
  try {
    const { execSync } = require('child_process');
    return execSync(`eval echo ~${user}`, { timeout: 2000 }).toString().trim() || '/root';
  } catch { return '/root'; }
}

function userUidOf(user) {
  try {
    const { execSync } = require('child_process');
    return parseInt(execSync(`id -u ${user}`, { timeout: 2000 }).toString().trim()) || 0;
  } catch { return 0; }
}

function makeShellEnv(user) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (!env.HOME) env.HOME = os.homedir();
  if (user && user !== (process.env.USER || 'root')) {
    const home = userHomeOf(user);
    const uid = userUidOf(user);
    env.HOME = home;
    env.USER = user;
    env.LOGNAME = user;
    env.SHELL = '/bin/bash';
    env.PATH = `${home}/.local/bin:${env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;
    // XDG / D-Bus for GUI tools
    const runDir = `/run/user/${uid}`;
    if (fs.existsSync(runDir)) {
      env.XDG_RUNTIME_DIR = runDir;
      if (fs.existsSync(`${runDir}/bus`)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runDir}/bus`;
    }
  }
  return env;
}

// Terminal records: id -> { term, buf, conns, cwd, user }
const terminals = new Map();
const TERM_BUF_MAX = 512 * 1024;
const TERM_WELCOME = '\r\n\x1b[90m— servEX terminal —\x1b[0m\r\n';

function spawnTermProc(rec, dir, user) {
  const nodePty = require('node-pty');
  const old = rec.term;
  const cols = old ? old.cols : 100;
  const rows = old ? old.rows : 30;
  if (old) {
    old._respawn = true;
    try { old.kill(); } catch {}
  }
  const curUser = process.env.USER || 'root';
  const targetUser = user || curUser;
  const env = makeShellEnv(targetUser);
  let bin, args;

  if (IS_ROOT && targetUser && targetUser !== curUser) {
    // setpriv: job control works correctly (unlike su)
    bin = 'setpriv';
    args = ['--reuid=' + targetUser, '--regid=' + targetUser, '--init-groups', '--', 'bash', '-l'];
  } else {
    bin = 'bash';
    args = ['-l'];
  }

  const child = nodePty.spawn(bin, args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: dir || userHomeOf(targetUser),
    env
  });
  rec.term = child;
  rec.buf = '';
  rec.cwd = dir;
  rec.user = targetUser;

  child.onData((data) => {
    rec.buf += data;
    if (rec.buf.length > TERM_BUF_MAX) rec.buf = rec.buf.slice(rec.buf.length - TERM_BUF_MAX);
    const s = JSON.stringify({ type: 'data', data });
    for (const c of Array.from(rec.conns)) {
      if (c.readyState === c.OPEN) try { c.send(s); } catch {}
    }
  });

  child.onExit(({ exitCode }) => {
    if (child._respawn) { child._respawn = false; return; }
    if (terminals.get(rec.id) === rec && rec.term === child) terminals.delete(rec.id);
    try { if (child.pid && process.getpgid(child.pid) === child.pid) process.kill(-child.pid, 'SIGHUP'); } catch {}
    try { child.kill(); } catch {}
    const s = JSON.stringify({ type: 'exit', code: exitCode });
    for (const c of Array.from(rec.conns)) {
      if (c.readyState === c.OPEN) try { c.send(s); } catch {}
    }
  });

  return child;
}

wss.on('connection', (ws, req) => {
  const q = new URL(req.url || '/', 'http://localhost').searchParams;
  const id = q.get('id') || ('p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  let startDir = ROOT_DIR;
  try {
    const c = q.get('cwd');
    if (c != null && c !== '') {
      const resolved = path.resolve(ROOT_DIR, c);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) startDir = resolved;
    }
  } catch {}
  const user = q.get('user') || TERM_USER;

  let rec = terminals.get(id);
  const fresh = !rec || !rec.term;

  if (fresh) {
    try {
      rec = { id, term: null, buf: '', conns: new Set(), cwd: startDir, user: user };
      terminals.set(id, rec);
      spawnTermProc(rec, startDir, user);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'data', data: '\r\n\x1b[31m[servEX] ' + e.message + '\x1b[0m\r\n' }));
      try { ws.close(); } catch {}
      return;
    }
  }
  rec.conns.add(ws);

  // Send welcome or buffer for reconnection
  ws.send(JSON.stringify({ type: 'data', data: fresh ? TERM_WELCOME : rec.buf }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      const t = rec.term;
      if (!t) return;
      if (msg.type === 'input') {
        t.write(msg.data);
      } else if (msg.type === 'resize') {
        t.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
      } else if (msg.type === 'cd') {
        const dir = String(msg.path || '');
        if (dir) rec.cwd = dir;
        t.write(`cd ${JSON.stringify(dir)} && clear\n`);
      } else if (msg.type === 'user') {
        const newUser = String(msg.user || TERM_USER);
        const newCwd = msg.cwd || rec.cwd || ROOT_DIR;
        spawnTermProc(rec, newCwd, newUser);
        rec.conns.add(ws);
        ws.send(JSON.stringify({ type: 'data', data: '\r\n\x1b[90m— Switched to ' + rec.user + ' —\x1b[0m\r\n' }));
      } else if (msg.type === 'kill') {
        try { t.kill(); } catch {}
        try { if (t.pid && process.getpgid(t.pid) === t.pid) process.kill(-t.pid, 'SIGHUP'); } catch {}
        terminals.delete(id);
        try { ws.close(); } catch {}
      }
    } catch {}
  });

  ws.on('close', () => {
    if (rec) rec.conns.delete(ws);
  });

  ws.on('error', () => {
    if (rec) rec.conns.delete(ws);
  });
});

// ── Update (git pull from GitHub) ──
app.post('/api/update', async (req, res) => {
  try {
    const installDir = process.env.SERVEX_DIR || path.join(__dirname, '..');
    // Stash local changes (ignore failure if nothing to stash)
    try { await sh('git', ['stash'], { cwd: installDir, timeout: 15000 }); } catch (_) {}
    const pullResult = await sh('git', ['pull', 'origin', 'main'], { cwd: installDir, timeout: 30000 });
    await sh('npm', ['install', '--production'], { cwd: path.join(installDir, 'server'), timeout: 60000 });
    res.json({ success: true, message: pullResult.stdout.trim() });
  } catch (e) {
    sendErr(res, e.message, 500);
  }
});

// ── Restart servEX service ──
app.post('/api/restart', async (req, res) => {
  try {
    // Respond first, then restart after a short delay so the client gets the response
    res.json({ success: true, message: '再起動します...' });
    setTimeout(() => {
      const svc = process.env.SERVEX_SERVICE || 'servex';
      exec(`systemctl restart ${svc}`, (err) => {
        if (err) console.error('Restart failed:', err.message);
      });
    }, 1000);
  } catch (e) {
    sendErr(res, e.message, 500);
  }
});

// ── Start ──
server.listen(PORT, HOST, () => {
  console.log(`servEX listening on http://${HOST}:${PORT}`);
  console.log(`Root: ${ROOT_DIR}`);
});
