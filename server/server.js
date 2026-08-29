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
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/terminal' });

wss.on('connection', (ws) => {
  let ptyProcess;
  let currentCwd = process.env.HOME || '/root';

  // Detect default non-root user
  let defaultUser = null;
  try {
    const { execSync } = require('child_process');
    const passwd = execSync('getent passwd', { timeout: 3000 }).toString();
    const candidates = passwd.split('\n').filter(Boolean).map(l => l.split(':')).filter(p => parseInt(p[2]) >= 1000 && parseInt(p[2]) < 65534 && p[6] && p[6].includes('bash'));
    if (candidates.length > 0) defaultUser = candidates[0][0];
  } catch (e) {}

  function spawnShell(user, cwd) {
    if (ptyProcess) ptyProcess.kill();
    const nodePty = require('node-pty');
    const shellCwd = cwd || currentCwd;
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const targetUser = user || defaultUser;

    if (targetUser && targetUser !== 'root') {
      ptyProcess = nodePty.spawn('su', ['-c', 'bash', targetUser], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: shellCwd,
        env
      });
    } else {
      ptyProcess = nodePty.spawn('bash', [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: shellCwd,
        env
      });
    }

    ptyProcess.onData((data) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      } catch (e) {}
    });

    ptyProcess.onExit(({ exitCode }) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        }
      } catch (e) {}
      ws.close();
    });
  }

  try {
    spawnShell(null, null);

    ptyProcess.onData((data) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      } catch (e) {}
    });

    ptyProcess.onExit(({ exitCode }) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        }
      } catch (e) {}
      ws.close();
    });

    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'input') {
          ptyProcess.write(parsed.data);
        } else if (parsed.type === 'resize') {
          ptyProcess.resize(parsed.cols || 80, parsed.rows || 24);
        } else if (parsed.type === 'cd') {
          currentCwd = parsed.path || currentCwd;
          ptyProcess.write(`cd "${parsed.path}" && clear\n`);
        } else if (parsed.type === 'su') {
          const user = parsed.user || 'root';
          currentCwd = parsed.cwd || currentCwd;
          spawnShell(user, currentCwd);
          ws.send(JSON.stringify({ type: 'connected', message: `Switched to ${user}` }));
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      if (ptyProcess) ptyProcess.kill();
    });

    ws.on('error', () => {
      if (ptyProcess) ptyProcess.kill();
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Terminal connected' }));
  } catch (e) {
    console.error('Terminal spawn error:', e.message);
    ws.send(JSON.stringify({ type: 'error', message: e.message }));
    ws.close();
  }
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
