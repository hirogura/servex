(function() {
  'use strict';

  const ROOT_PREFIX = '/';

  // ── State ──
  const state = {
    panes: {
      top: { currentPath: '/', viewMode: 'list', items: [], selectedItem: null, selectedItems: new Set(), expandedPaths: new Set(), treeData: {} },
      bottom: { currentPath: '/', viewMode: 'list', items: [], selectedItem: null, selectedItems: new Set(), expandedPaths: new Set(), treeData: {} }
    },
    activePane: 'top',
    clipboard: null, // { paths: [], action: 'copy'|'move' }
    terminal: null,
    terminalFitAddon: null,
    ws: null
  };

  // ── Tree Icons ──
  const TREE_FOLDER_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#89b4fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';
  const TREE_FOLDER_OPEN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#89b4fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1"/><path d="M3 14h4l2 2"/></svg>';

  // ── DOM References ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elements = {
    fileListTop: $('#file-list-top'),
    fileListBottom: $('#file-list-bottom'),
    pathTop: $('#path-top'),
    pathBottom: $('#path-bottom'),
    contextMenu: $('#context-menu'),
    infoDetail: $('#info-detail'),
    infoEmpty: $('.info-empty'),
    statusText: $('#status-text'),
    statusInfo: $('#status-info'),
    terminalContainer: $('#terminal-container'),
    dialogOverlay: $('#dialog-overlay'),
    dialog: $('#dialog'),
    dialogTitle: $('#dialog-title'),
    dialogBody: $('#dialog-body'),
    uploadOverlay: $('#upload-overlay')
  };

  // ── API Helper ──
  async function api(endpoint, options = {}) {
    const r = await fetch(`/api${endpoint}`, options);
    const d = await r.json();
    if (!d.success) throw new Error(d.error || 'API error');
    return d;
  }

  function showStatus(msg) {
    elements.statusText.textContent = msg;
  }

  // ── Tree (Explorer Sidebar) ──
  async function loadTree(pane, dirPath) {
    try {
      const d = await api(`/tree?path=${encodeURIComponent(dirPath || '')}`);
      state.panes[pane].treeData[dirPath || ''] = d.items;
      renderTree(pane);
    } catch (e) {
      console.error('Tree load error:', e);
    }
  }

  function renderTree(pane) {
    const p = state.panes[pane];
    const items = p.treeData[''] || [];
    const containerId = pane === 'top' ? 'tree-container-top' : 'tree-container-bottom';
    const container = document.getElementById(containerId);
    if (!container) return;

    let html = `<div class="tree-item"><div class="tree-item-content ${p.currentPath === '/' ? 'active' : ''}" data-pane="${pane}" data-path="/" data-has-children="true">
      <span class="tree-chevron expanded"></span>
      <span class="tree-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#89b4fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h2"/></svg></span>
      <span>/ (root)</span>
    </div>`;

    html += renderTreeLevel(pane, items, 0);
    html += '</div>';
    container.innerHTML = html;
    attachTreeListeners(pane);
  }

  function renderTreeLevel(pane, items, depth) {
    if (!items || !items.length) return '';
    const p = state.panes[pane];
    return items.map(item => {
      const expanded = p.expandedPaths.has(item.path);
      const active = p.currentPath === item.path;
      const icon = expanded ? TREE_FOLDER_OPEN_SVG : TREE_FOLDER_SVG;
      return `<div class="tree-item"><div class="tree-item-content ${active ? 'active' : ''}" data-pane="${pane}" data-path="${item.path}" data-has-children="${item.hasChildren}">
        <span class="tree-chevron ${expanded ? 'expanded' : ''}">${item.hasChildren ? '▶' : ''}</span>
        <span class="tree-icon">${icon}</span>
        <span>${item.name}</span>
      </div>${expanded && p.treeData[item.path] ? `<div class="tree-children">${renderTreeLevel(pane, p.treeData[item.path], depth + 1)}</div>` : ''}</div>`;
    }).join('');
  }

  function attachTreeListeners(pane) {
    const containerId = pane === 'top' ? 'tree-container-top' : 'tree-container-bottom';
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.tree-item-content').forEach(el => {
      el.addEventListener('click', handleTreeClick);
      el.addEventListener('contextmenu', handleTreeContextMenu);
    });
  }

  // ── Tree Context Menu ──
  let treeContextTarget = null; // { pane, path, name }

  function handleTreeContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const pane = el.dataset.pane;
    const p = el.dataset.path;
    treeContextTarget = { pane, path: p, name: p === '/' ? '/' : p.split('/').pop() };

    const menu = document.getElementById('tree-context-menu');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('show');
    // Adjust if menu goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, e.clientY - rect.height)}px`;
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, e.clientX - rect.width)}px`;
  }

  function hideTreeContextMenu() {
    document.getElementById('tree-context-menu').classList.remove('show');
  }

  async function handleTreeContextAction(action) {
    const ctx = treeContextTarget;
    if (!ctx) return;
    hideTreeContextMenu();

    switch (action) {
      case 'mkdir':
        showMkdirDialog(ctx.path);
        break;
      case 'createfile':
        showCreatefileDialog(ctx.path);
        break;
      case 'rename':
        showRenameDialog({ path: ctx.path, name: ctx.name });
        break;
      case 'copy-path':
        navigator.clipboard.writeText(ctx.path).then(() => showStatus('パスをコピーしました'));
        break;
      case 'delete': {
        if (ctx.path === '/') return;
        if (!confirm(`「${ctx.name}」を削除しますか？`)) return;
        try {
          await api('/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ctx.path }) });
          showStatus('削除しました');
          loadTree(ctx.pane, ctx.path);
          navigateTo(ctx.pane, state.panes[ctx.pane].currentPath, true);
        } catch (err) {
          showStatus(`削除エラー: ${err.message}`);
        }
        break;
      }
    }
    treeContextTarget = null;
  }

  async function handleTreeClick(e) {
    const el = e.currentTarget;
    const pane = el.dataset.pane;
    const p = el.dataset.path;
    const hasChildren = el.dataset.hasChildren === 'true';
    const paneState = state.panes[pane];

    if (hasChildren) {
      if (paneState.expandedPaths.has(p)) {
        paneState.expandedPaths.delete(p);
      } else {
        paneState.expandedPaths.add(p);
        if (!paneState.treeData[p]) await loadTree(pane, p);
      }
    }

    navigateTo(pane, p, true);
  }

  function expandParentPaths(pane, p) {
    if (!p || p === '/') return;
    const parts = p.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      state.panes[pane].expandedPaths.add('/' + current);
    }
  }

  function initLeftSidebarResize() {
    const handle = document.getElementById('resize-handle-left');
    const sidebar = document.getElementById('left-sidebar');
    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(150, Math.min(400, e.clientX));
      sidebar.style.width = w + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });


  }

  // ── File Icons (flat SVG) ──
  const SVG_FOLDER = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#89b4fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';
  const SVG_FILE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a6adc8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const SVG_IMAGE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a6e3a1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  const SVG_VIDEO = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#cba6f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
  const SVG_MUSIC = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f9e2af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  const SVG_ARCHIVE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fab387" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
  const SVG_CODE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#89dceb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  const SVG_DOC = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#cdd6f4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  const SVG_DATA = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f38ba8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';

  function getFileIcon(item) {
    if (item.isDirectory) return SVG_FOLDER;
    const ext = (item.extension || '').toLowerCase();
    if (['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg'].includes(ext)) return SVG_IMAGE;
    if (['.mp4','.avi','.mkv','.mov','.webm'].includes(ext)) return SVG_VIDEO;
    if (['.mp3','.wav','.flac','.ogg','.m4a'].includes(ext)) return SVG_MUSIC;
    if (['.zip','.rar','.7z','.tar','.gz'].includes(ext)) return SVG_ARCHIVE;
    if (['.js','.ts','.py','.java','.html','.css'].includes(ext)) return SVG_CODE;
    if (['.json','.xml','.yaml','.yml'].includes(ext)) return SVG_DATA;
    if (['.pdf','.doc','.docx','.odt','.txt','.md','.log'].includes(ext)) return SVG_DOC;
    return SVG_FILE;
  }

  function formatSize(b) {
    if (b === 0) return '-';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
  }

  function formatDate(d) {
    return new Date(d).toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function isImageFile(ext) {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext.toLowerCase());
  }

  // ── Navigation ──
  function navigateTo(pane, path, skipTree) {
    const p = state.panes[pane];
    p.currentPath = path || '/';
    p.selectedItem = null;
    p.selectedItems.clear();
    const pathInput = pane === 'top' ? elements.pathTop : elements.pathBottom;
    pathInput.value = p.currentPath;
    showStatus('読み込み中...');
    api(`/browse?path=${encodeURIComponent(p.currentPath)}`).then(d => {
      p.items = d.items;
      renderFileList(pane);
      updateItemCount(pane);
      showStatus('準備完了');
    }).catch(e => showStatus(`エラー: ${e.message}`));
    if (!skipTree) expandParentPaths(pane, p.currentPath);
    renderTree(pane);
  }

  function goUp(pane) {
    const p = state.panes[pane];
    if (p.currentPath === '/') return;
    const parts = p.currentPath.split('/').filter(Boolean);
    parts.pop();
    navigateTo(pane, '/' + parts.join('/'));
  }

  function goHome(pane) {
    navigateTo(pane, '/');
  }

  // ── Render File List ──
  function renderFileList(pane) {
    const p = state.panes[pane];
    const container = pane === 'top' ? elements.fileListTop : elements.fileListBottom;
    const sorted = sortItems(p.items);

    if (!sorted.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg></div><p>フォルダは空です</p></div>';
      return;
    }

    container.className = `file-list ${p.viewMode === 'thumb' ? 'thumbnail-view' : ''}`;
    container.innerHTML = sorted.map(item => {
      const sel = p.selectedItem && p.selectedItem.path === item.path;
      const msel = p.selectedItems.has(item.path);
      const icon = getFileIcon(item);

      if (p.viewMode === 'thumb') {
        return `<div class="file-item ${sel ? 'selected' : msel ? 'multi-selected' : ''}" 
                     data-path="${item.path}" data-is-directory="${item.isDirectory}" 
                     data-pane="${pane}" data-drop-target="true" draggable="true">
          <div class="file-icon">${icon}</div>
          <div class="file-info"><div class="file-name" title="${item.name}">${item.name}</div></div>
        </div>`;
      }

      return `<div class="file-item ${sel ? 'selected' : msel ? 'multi-selected' : ''}" 
                   data-path="${item.path}" data-is-directory="${item.isDirectory}"
                   data-pane="${pane}" data-drop-target="true" draggable="true">
        <div class="file-icon">${icon}</div>
        <div class="file-info">
          <div class="file-name" title="${item.name}">${item.name}</div>
          <div class="file-meta">${item.owner}:${item.group}</div>
        </div>
        <span class="file-perms">${item.permissions}</span>
        <span class="file-size">${item.isDirectory ? '-' : formatSize(item.size)}</span>
        <span class="file-date">${formatDate(item.modified)}</span>
      </div>`;
    }).join('');

    attachFileListeners(pane);
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'ja');
    });
  }

  function updateItemCount(pane) {
    const p = state.panes[pane];
    const dirs = p.items.filter(i => i.isDirectory).length;
    const files = p.items.filter(i => !i.isDirectory).length;
    let t = '';
    if (dirs > 0) t += `${dirs} フォルダ`;
    if (dirs > 0 && files > 0) t += '、';
    if (files > 0) t += `${files} ファイル`;
    if (!t) t = '0 件';
    const ms = p.selectedItems.size;
    if (ms > 0) t += ` (${ms}件選択中)`;
    elements.statusInfo.textContent = t;
  }

  // ── File Listeners ──
  function attachFileListeners(pane) {
    const container = pane === 'top' ? elements.fileListTop : elements.fileListBottom;
    container.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const path = el.dataset.path;
        const p = state.panes[pane];

        if (e.ctrlKey || e.metaKey) {
          if (p.selectedItems.has(path)) {
            p.selectedItems.delete(path);
            el.classList.remove('multi-selected');
          } else {
            p.selectedItems.add(path);
            el.classList.add('multi-selected');
          }
          p.selectedItem = p.items.find(i => p.selectedItems.has(i.path)) || null;
          updateItemCount(pane);
          return;
        }

        if (!e.shiftKey) {
          container.querySelectorAll('.file-item').forEach(i => {
            i.classList.remove('selected', 'multi-selected');
          });
          p.selectedItems.clear();
          p.selectedItem = p.items.find(i => i.path === path);
          el.classList.add('selected');
          updateItemCount(pane);
          updateInfoPanel(p.selectedItem);
        }
      });

      el.addEventListener('dblclick', () => {
        const ext = '.' + el.dataset.path.split('.').pop().toLowerCase();
        if (el.dataset.isDirectory === 'true') {
          navigateTo(pane, el.dataset.path);
        } else {
          window.open(`/api/view?path=${encodeURIComponent(el.dataset.path)}`, '_blank');
        }
      });

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const path = el.dataset.path;
        const p = state.panes[pane];
        if (!e.ctrlKey && !e.metaKey && !p.selectedItems.has(path)) {
          p.selectedItems.clear();
          container.querySelectorAll('.file-item.multi-selected').forEach(x => x.classList.remove('multi-selected'));
          p.selectedItem = p.items.find(i => i.path === path);
          el.classList.add('selected');
          updateItemCount(pane);
          updateInfoPanel(p.selectedItem);
        }
        state.activePane = pane;
        showContextMenu(e.clientX, e.clientY);
      });

      // Drag & Drop
      el.addEventListener('dragstart', (e) => {
        state.clipboard = null;
        const p = state.panes[pane];
        // If the dragged item is in a multi-selection, drag all selected items
        if (p.selectedItems.size > 1 && p.selectedItems.has(el.dataset.path)) {
          e.dataTransfer.setData('application/x-servex-paths', JSON.stringify([...p.selectedItems]));
        } else {
          e.dataTransfer.setData('application/x-servex-paths', JSON.stringify([el.dataset.path]));
        }
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });

      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        container.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      });

      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (el.dataset.isDirectory === 'true') {
          e.dataTransfer.dropEffect = 'move';
        }
      });

      el.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (el.dataset.isDirectory === 'true') {
          el.classList.add('drag-over');
        }
      });

      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over');
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
        if (el.dataset.isDirectory !== 'true') return;
        const pathsRaw = e.dataTransfer.getData('application/x-servex-paths');
        if (!pathsRaw) return;
        let sourcePaths;
        try { sourcePaths = JSON.parse(pathsRaw); } catch (_) { return; }
        const destPath = el.dataset.path;
        if (!sourcePaths.length || !destPath) return;
        // Don't drop onto itself
        if (sourcePaths.length === 1 && sourcePaths[0] === destPath) return;
        showDdDialog(sourcePaths, destPath);
      });
    });
  }

  // ── D&D Action Dialog ──
  let ddState = null; // { sourcePaths, destPath }

  function showDdDialog(sourcePaths, destPath) {
    ddState = { sourcePaths, destPath };
    const overlay = document.getElementById('dd-dialog-overlay');
    const count = sourcePaths.length;
    const destName = destPath === '/' ? '/' : destPath.split('/').pop();
    const desc = count === 1
      ? `「${sourcePaths[0].split('/').pop()}」を「${destName}」にどうしますか？`
      : `${count}件のアイテムを「${destName}」にどうしますか？`;
    document.getElementById('dd-dialog-desc').textContent = desc;
    overlay.classList.add('show');
  }

  function hideDdDialog() {
    document.getElementById('dd-dialog-overlay').classList.remove('show');
    ddState = null;
  }

  async function ddAction(action) {
    const { sourcePaths, destPath } = ddState || {};
    if (!sourcePaths || !destPath) return;
    hideDdDialog();

    const isMove = action === 'move';
    const apiPath = isMove
      ? (sourcePaths.length === 1 ? '/move' : '/move-batch')
      : (sourcePaths.length === 1 ? '/copy' : '/copy-batch');
    const body = sourcePaths.length === 1
      ? { sourcePath: sourcePaths[0], destPath }
      : { paths: sourcePaths, destPath };

    try {
      showStatus(`${isMove ? '移動' : 'コピー'}中...`);
      await api(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      showStatus(`${sourcePaths.length}件を${isMove ? '移動' : 'コピー'}しました`);
      // Refresh both panes that might be affected
      ['top', 'bottom'].forEach(pane => {
        navigateTo(pane, state.panes[pane].currentPath, true);
      });
    } catch (err) {
      showStatus(`${isMove ? '移動' : 'コピー'}エラー: ${err.message}`);
    }
  }

  // ── Context Menu ──
  function showContextMenu(x, y) {
    const menu = elements.contextMenu;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('show');
    // Adjust if menu goes off bottom
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, y - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, x - rect.width)}px`;
    }
  }

  function hideContextMenu() {
    elements.contextMenu.classList.remove('show');
  }

  async function handleContextAction(action) {
    const pane = state.activePane;
    const p = state.panes[pane];
    const item = p.selectedItem;
    if (!item && !['copy', 'move'].includes(action)) return;

    switch (action) {
      case 'open':
        if (item.isDirectory) navigateTo(pane, item.path);
        else window.open(`/api/view?path=${encodeURIComponent(item.path)}`, '_blank');
        break;

      case 'copy':
        state.clipboard = {
          paths: p.selectedItems.size > 0 ? [...p.selectedItems] : [item.path],
          action: 'copy'
        };
        showStatus(`${state.clipboard.paths.length}件をコピーしました（貼り付け先で右クリック→貼り付け）`);
        break;

      case 'move':
        state.clipboard = {
          paths: p.selectedItems.size > 0 ? [...p.selectedItems] : [item.path],
          action: 'move'
        };
        showStatus(`${state.clipboard.paths.length}件を切り取りました（貼り付け先で右クリック→貼り付け）`);
        break;

      case 'download': {
        const paths = p.selectedItems.size > 0 ? [...p.selectedItems] : [item.path];
        if (paths.length === 1) {
          const a = document.createElement('a');
          a.href = `/api/download?path=${encodeURIComponent(paths[0])}`;
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } else {
          fetch('/api/download-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths })
          }).then(r => r.blob()).then(b => {
            const u = URL.createObjectURL(b);
            const a = document.createElement('a');
            a.href = u;
            a.download = 'download.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(u);
          });
        }
        showStatus('ダウンロードを開始しました');
        break;
      }

      case 'rename':
        showRenameDialog(item);
        break;

      case 'mkdir':
        showMkdirDialog();
        break;

      case 'createfile':
        showCreatefileDialog();
        break;

      case 'copy-path': {
        const fullPath = ROOT_PREFIX + (item.path ? item.path : '');
        navigator.clipboard.writeText(fullPath).then(() => showStatus('パスをコピーしました'));
        break;
      }

      case 'open-terminal': {
        switchToTab('terminal');
        openTerminalAt(item.isDirectory ? item.path : item.path.split('/').slice(0, -1).join('/') || '/');
        break;
      }

      case 'delete': {
        const paths = p.selectedItems.size > 0 ? [...p.selectedItems] : [item.path];
        const msg = paths.length === 1 ? `「${paths[0].split('/').pop()}」を削除しますか？` : `${paths.length}件のファイルを削除しますか？`;
        if (!confirm(msg)) return;
        try {
          if (paths.length === 1) {
            await api('/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: paths[0] }) });
          } else {
            await api('/delete-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
          }
          showStatus('削除しました');
          p.selectedItems.clear();
          p.selectedItem = null;
          navigateTo(pane, p.currentPath, true);
        } catch (err) {
          showStatus(`削除エラー: ${err.message}`);
        }
        break;
      }

      case 'paste': {
        if (!state.clipboard) {
          showStatus('コピー/切り取りされたアイテムがありません');
          break;
        }
        const destPath = p.currentPath;
        try {
          showStatus(`${state.clipboard.paths.length}件を${state.clipboard.action === 'copy' ? 'コピー' : '移動'}中...`);
          if (state.clipboard.paths.length === 1) {
            const apiPath = state.clipboard.action === 'copy' ? '/copy' : '/move';
            await api(apiPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sourcePath: state.clipboard.paths[0], destPath })
            });
          } else {
            const apiPath = state.clipboard.action === 'copy' ? '/copy-batch' : '/move-batch';
            await api(apiPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paths: state.clipboard.paths, destPath })
            });
          }
          showStatus(`${state.clipboard.paths.length}件を${state.clipboard.action === 'copy' ? 'コピー' : '移動'}しました`);
          if (state.clipboard.action === 'move') state.clipboard = null;
          navigateTo(pane, p.currentPath, true);
        } catch (err) {
          showStatus(`エラー: ${err.message}`);
        }
        break;
      }
    }
    hideContextMenu();
  }

  // ── Info Panel ──
  async function updateInfoPanel(item) {
    if (!item) {
      elements.infoDetail.style.display = 'none';
      elements.infoEmpty.style.display = 'flex';
      return;
    }

    try {
      const data = await api(`/info?path=${encodeURIComponent(item.path)}`);
      const info = data.info;

      elements.infoEmpty.style.display = 'none';
      elements.infoDetail.style.display = 'block';

      $('#info-icon').innerHTML = getFileIcon(item);
      $('#info-name').textContent = info.name;
      $('#info-path').textContent = info.absPath;
      $('#info-size').textContent = info.isDirectory ? '-' : formatSize(info.size);
      $('#info-type').textContent = info.isDirectory ? 'フォルダ' : (info.name.split('.').pop().toUpperCase() || 'ファイル');
      $('#info-modified').textContent = formatDate(info.modified);
      $('#info-created').textContent = formatDate(info.created);
      $('#info-owner').textContent = info.owner;
      $('#info-group').textContent = info.group;
      $('#info-perms').textContent = info.permissions;

      // Set permission checkboxes
      const perms = info.permissions.replace('0', '').split('').map(Number);
      const userPerms = perms[0] || 0;
      const groupPerms = perms[1] || 0;
      const otherPerms = perms[2] || 0;

      $('#perm-r-user').checked = (userPerms & 4) !== 0;
      $('#perm-w-user').checked = (userPerms & 2) !== 0;
      $('#perm-x-user').checked = (userPerms & 1) !== 0;
      $('#perm-r-group').checked = (groupPerms & 4) !== 0;
      $('#perm-w-group').checked = (groupPerms & 2) !== 0;
      $('#perm-x-group').checked = (groupPerms & 1) !== 0;
      $('#perm-r-other').checked = (otherPerms & 4) !== 0;
      $('#perm-w-other').checked = (otherPerms & 2) !== 0;
      $('#perm-x-other').checked = (otherPerms & 1) !== 0;

      // Load users and groups
      await loadUsersGroups(info.owner, info.group);

      // Store current path for permission changes
      elements.infoDetail.dataset.path = info.path;
    } catch (err) {
      showStatus(`情報取得エラー: ${err.message}`);
    }
  }

  async function loadUsersGroups(currentOwner, currentGroup) {
    try {
      const [usersData, groupsData] = await Promise.all([
        api('/users'),
        api('/groups')
      ]);

      const ownerSelect = $('#perm-owner');
      const groupSelect = $('#perm-group');

      ownerSelect.innerHTML = usersData.users.map(u =>
        `<option value="${u.name}" ${u.name === currentOwner ? 'selected' : ''}>${u.name}</option>`
      ).join('');

      groupSelect.innerHTML = groupsData.groups.map(g =>
        `<option value="${g.name}" ${g.name === currentGroup ? 'selected' : ''}>${g.name}</option>`
      ).join('');
    } catch (e) {}
  }

  async function applyPermissions() {
    const path = elements.infoDetail.dataset.path;
    if (!path) return;

    const owner = $('#perm-owner').value;
    const group = $('#perm-group').value;

    const rUser = $('#perm-r-user').checked ? 4 : 0;
    const wUser = $('#perm-w-user').checked ? 2 : 0;
    const xUser = $('#perm-x-user').checked ? 1 : 0;
    const rGroup = $('#perm-r-group').checked ? 4 : 0;
    const wGroup = $('#perm-w-group').checked ? 2 : 0;
    const xGroup = $('#perm-x-group').checked ? 1 : 0;
    const rOther = $('#perm-r-other').checked ? 4 : 0;
    const wOther = $('#perm-w-other').checked ? 2 : 0;
    const xOther = $('#perm-x-other').checked ? 1 : 0;

    const perms = String((rUser + wUser + xUser) * 64 + (rGroup + wGroup + xGroup) * 8 + (rOther + wOther + xOther));

    try {
      await Promise.all([
        api('/chmod', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, permissions: perms }) }),
        api('/chown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, owner, group }) })
      ]);
      showStatus('権限を変更しました');
      // Refresh info
      const pane = state.activePane;
      navigateTo(pane, state.panes[pane].currentPath, true);
      // Re-select the item
      setTimeout(() => {
        const p = state.panes[pane];
        const item = p.items.find(i => i.path === path);
        if (item) {
          p.selectedItem = item;
          updateInfoPanel(item);
        }
      }, 300);
    } catch (err) {
      showStatus(`権限変更エラー: ${err.message}`);
    }
  }

  // ── Dialogs ──
  function showDialog(title, body, onOk) {
    elements.dialogTitle.textContent = title;
    elements.dialogBody.innerHTML = body;
    elements.dialogOverlay.classList.add('show');
    const okBtn = $('#dialog-ok');
    const cancelBtn = $('#dialog-cancel');
    const closeBtn = $('#dialog-close');

    const close = () => elements.dialogOverlay.classList.remove('show');
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    okBtn.onclick = async () => {
      try {
        await onOk();
        close();
      } catch (err) {
        showStatus(`エラー: ${err.message}`);
      }
    };

    // Focus first input
    setTimeout(() => {
      const input = elements.dialogBody.querySelector('input');
      if (input) {
        input.focus();
        input.select();
      }
    }, 100);
  }

  function showRenameDialog(item) {
    showDialog('名前を変更', `
      <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-secondary)">新しい名前:</label>
      <input type="text" class="dialog-input" id="dialog-rename-input" value="${item.name}">
    `, async () => {
      const newName = $('#dialog-rename-input').value.trim();
      if (!newName) throw new Error('名前を入力してください');
      await api('/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: item.path, newName })
      });
      showStatus('名前を変更しました');
      const pane = state.activePane;
      navigateTo(pane, state.panes[pane].currentPath, true);
    });
  }

  function showMkdirDialog(targetPath) {
    const pane = state.activePane;
    const destPath = targetPath || state.panes[pane].currentPath;
    showDialog('フォルダを作成', `
      <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-secondary)">フォルダ名:</label>
      <input type="text" class="dialog-input" id="dialog-mkdir-input" placeholder="新しいフォルダ">
    `, async () => {
      const name = $('#dialog-mkdir-input').value.trim();
      if (!name) throw new Error('フォルダ名を入力してください');
      await api('/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: destPath, name })
      });
      showStatus('フォルダを作成しました');
      navigateTo(pane, state.panes[pane].currentPath, true);
    });
  }

  function showCreatefileDialog(targetPath) {
    const pane = state.activePane;
    const destPath = targetPath || state.panes[pane].currentPath;
    showDialog('ファイルを作成', `
      <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-secondary)">ファイル名:</label>
      <input type="text" class="dialog-input" id="dialog-createfile-input" placeholder="新しいファイル">
      <label style="display:block;margin-top:10px;margin-bottom:6px;font-size:12px;color:var(--text-secondary)">拡張子:</label>
      <input type="text" class="dialog-input" id="dialog-createfile-ext" value=".txt" placeholder=".txt">
    `, async () => {
      const name = $('#dialog-createfile-input').value.trim();
      const type = $('#dialog-createfile-ext').value.trim();
      if (!name) throw new Error('ファイル名を入力してください');
      await api('/createfile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: destPath, name, type })
      });
      showStatus('ファイルを作成しました');
      navigateTo(pane, state.panes[pane].currentPath, true);
    });
  }

  // ── Upload ──
  function showUploadDialog() {
    elements.uploadOverlay.classList.add('show');
    const uploadList = $('#upload-list');
    uploadList.innerHTML = '';

    const fileInput = $('#file-input');
    fileInput.value = '';
    fileInput.onchange = () => handleUploadFiles(fileInput.files);

    const zone = $('#upload-zone');
    zone.onclick = () => fileInput.click();
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('dragover'); };
    zone.ondragleave = () => zone.classList.remove('dragover');
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      handleUploadFiles(e.dataTransfer.files);
    };
  }

  async function handleUploadFiles(files) {
    if (!files || !files.length) return;
    const pane = state.activePane;
    const p = state.panes[pane];
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    try {
      showStatus(`${files.length}件をアップロード中...`);
      await fetch(`/api/upload?path=${encodeURIComponent(p.currentPath)}`, {
        method: 'POST',
        body: formData
      });
      showStatus('アップロードが完了しました');
      elements.uploadOverlay.classList.remove('show');
      navigateTo(pane, p.currentPath, true);
    } catch (err) {
      showStatus(`アップロードエラー: ${err.message}`);
    }
  }

  // ── Terminal ──
  let termId = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  let termIsRoot = false;
  let termUser = null;

  function initTerminal() {
    if (state.terminal) return;

    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon;
    if (!Terminal || !FitAddon) {
      console.error('[servEX] xterm.js not loaded');
      return;
    }

    try {
      state.terminal = new Terminal({
        theme: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          cursor: '#c9d1d9',
          selectionBackground: '#264f78'
        },
        fontFamily: "'Cascadia Code','Fira Code',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true
      });

      state.terminalFitAddon = new FitAddon.FitAddon();
      state.terminal.loadAddon(state.terminalFitAddon);
      state.terminal.open(elements.terminalContainer);

      // Fit after DOM layout settles
      setTimeout(() => {
        try { state.terminalFitAddon.fit(); } catch (e) { console.error('fit error:', e); }
      }, 200);

      state.terminal.onData((data) => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      state.terminal.onResize(({ cols, rows }) => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      // Connect immediately (server detects user automatically)
      connectTerminal(null, null);
    } catch (e) {
      console.error('[servEX] Terminal init error:', e);
    }
  }

  function connectTerminal(cwd, user) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    params.set('id', termId);
    if (cwd) params.set('cwd', cwd);
    if (user) params.set('user', user);
    const url = `${protocol}//${location.host}/ws/terminal?${params.toString()}`;
    console.log('[servEX] Connecting terminal to:', url);
    state.ws = new WebSocket(url);

    state.ws.onopen = () => {
      console.log('[servEX] Terminal WebSocket connected');
      showStatus('ターミナルに接続しました');
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data') {
          state.terminal.write(msg.data);
        } else if (msg.type === 'exit') {
          state.terminal.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
        }
      } catch (e) {}
    };

    state.ws.onclose = () => {
      if (state.terminal) {
        state.terminal.write('\r\n\x1b[31m[接続が切れました。再接続します…]\x1b[0m\r\n');
        setTimeout(() => connectTerminal(null, null), 2000);
      }
    };

    state.ws.onerror = (e) => { console.error('[servEX] Terminal WebSocket error:', e); };
  }

  function openTerminalAt(path) {
    if (!state.terminal) initTerminal();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'cd', path }));
    }
  }

  // ── Sidebar Tabs ──
  function switchToTab(tabName) {
    $$('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    $('#tab-info').style.display = tabName === 'info' ? 'block' : 'none';
    $('#tab-terminal').style.display = tabName === 'terminal' ? 'block' : 'none';

    if (tabName === 'terminal') {
      if (!state.terminal) initTerminal();
      // Delay fit to ensure container has layout dimensions
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (state.terminalFitAddon) state.terminalFitAddon.fit();
        }, 50);
      });
    }
  }

  // ── Resize Handles ──
  function initResize() {
    const dualPane = $('#dual-pane');
    const handleH = $('#resize-handle-h');
    const paneTop = $('#pane-top');
    const paneBottom = $('#pane-bottom');

    let startY, startTopHeight;

    handleH.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startTopHeight = paneTop.getBoundingClientRect().height;

      const onMouseMove = (e) => {
        const dy = e.clientY - startY;
        const newHeight = Math.max(100, startTopHeight + dy);
        const totalHeight = dualPane.getBoundingClientRect().height;
        const pct = (newHeight / totalHeight) * 100;
        paneTop.style.flex = `0 0 ${pct}%`;
        paneBottom.style.flex = `0 0 ${100 - pct - 1}%`;
        // Sync tree pane split
        const treeTop = document.getElementById('tree-pane-top');
        const treeBottom = document.getElementById('tree-pane-bottom');
        if (treeTop && treeBottom) {
          treeTop.style.flex = `0 0 ${pct}%`;
          treeBottom.style.flex = `0 0 ${100 - pct - 1}%`;
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Vertical resize
    const handleV = $('#resize-handle-v');
    const sidebar = $('#right-sidebar');
    let startX, startWidth;

    handleV.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;

      const onMouseMove = (e) => {
        const dx = startX - e.clientX;
        const newWidth = Math.max(200, Math.min(600, startWidth + dx));
        sidebar.style.width = `${newWidth}px`;
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (state.terminalFitAddon) state.terminalFitAddon.fit();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ── Event Listeners ──
  function initEventListeners() {
    // Path bar buttons
    $$('.path-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pane = btn.dataset.pane;
        const action = btn.dataset.action;
        if (action === 'home') goHome(pane);
        else if (action === 'up') goUp(pane);
        else if (action === 'refresh') navigateTo(pane, state.panes[pane].currentPath, true);
      });
    });

    // View mode buttons
    $$('.pane-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pane = btn.dataset.pane;
        const view = btn.dataset.view;
        state.panes[pane].viewMode = view;
        $$(`.pane-btn[data-pane="${pane}"]`).forEach(b => b.classList.toggle('active', b.dataset.view === view));
        renderFileList(pane);
      });
    });

    // Context menu
    $$('.menu-item[data-action]').forEach(item => {
      item.addEventListener('click', () => handleContextAction(item.dataset.action));
    });

    document.addEventListener('click', hideContextMenu);

    // D&D action dialog
    $('#dd-btn-move').addEventListener('click', () => ddAction('move'));
    $('#dd-btn-copy').addEventListener('click', () => ddAction('copy'));
    $('#dd-btn-cancel').addEventListener('click', hideDdDialog);
    document.getElementById('dd-dialog-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'dd-dialog-overlay') hideDdDialog();
    });

    // Tree context menu
    $$('#tree-context-menu .menu-item').forEach(item => {
      item.addEventListener('click', () => handleTreeContextAction(item.dataset.taction));
    });
    document.addEventListener('click', hideTreeContextMenu);

    // Tree refresh buttons
    $('#tree-refresh-top').addEventListener('click', () => {
      state.panes.top.treeData = {};
      state.panes.top.expandedPaths.clear();
      loadTree('top', '');
      showStatus('上ツリーを更新しました');
    });
    $('#tree-refresh-bottom').addEventListener('click', () => {
      state.panes.bottom.treeData = {};
      state.panes.bottom.expandedPaths.clear();
      loadTree('bottom', '');
      showStatus('下ツリーを更新しました');
    });

    // Header actions
    $('#btn-upload').addEventListener('click', showUploadDialog);
    $('#btn-mkdir').addEventListener('click', showMkdirDialog);
    $('#btn-createfile').addEventListener('click', showCreatefileDialog);

    // Reload page after restart (with retry)
    function reloadAfterRestart(delay) {
      setTimeout(() => {
        const check = setInterval(() => {
          fetch('/api/browse?path=/').then(() => {
            clearInterval(check);
            location.reload();
          }).catch(() => {});
        }, 2000);
      }, delay || 3000);
    }

    // Update button
    $('#btn-update').addEventListener('click', async () => {
      if (!confirm('GitHubから最新コードを取得してアップデートしますか？')) return;
      try {
        showStatus('アップデート中...');
        const r = await fetch('/api/update', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          showStatus('アップデート完了。再起動してリロードします...');
          fetch('/api/restart', { method: 'POST' }).catch(() => {});
          reloadAfterRestart(3000);
        } else {
          showStatus('アップデートエラー: ' + (d.error || '不明なエラー'));
        }
      } catch (err) {
        // Network error means server is restarting — that's expected
        showStatus('アップデート完了。サーバー再起動中...');
        reloadAfterRestart(5000);
      }
    });

    // Restart button
    $('#btn-restart').addEventListener('click', async () => {
      if (!confirm('servEXサービスを再起動しますか？')) return;
      showStatus('再起動中。ページをリロードします...');
      fetch('/api/restart', { method: 'POST' }).catch(() => {});
      reloadAfterRestart(3000);
    });

    // Sidebar tabs
    $$('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => switchToTab(tab.dataset.tab));
    });

    // Permission apply
    $('#btn-apply-perms').addEventListener('click', applyPermissions);

    // Terminal buttons
    $('#btn-open-terminal').addEventListener('click', () => {
      const pane = state.activePane;
      const p = state.panes[pane];
      openTerminalAt(p.currentPath);
    });

    $('#btn-clear-terminal').addEventListener('click', () => {
      if (state.terminal) state.terminal.clear();
    });

    // Root toggle
    $('#btn-terminal-root').addEventListener('click', () => {
      if (!state.terminal) initTerminal();
      const pane = state.activePane;
      const cwd = state.panes[pane].currentPath;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        termIsRoot = !termIsRoot;
        const targetUser = termIsRoot ? 'root' : termUser;
        state.ws.send(JSON.stringify({ type: 'user', user: targetUser, cwd }));
        $('#btn-terminal-root').classList.toggle('root-active', termIsRoot);
        showStatus(termIsRoot ? 'rootに切り替えました' : `${termUser}に戻しました`);
      }
    });

    // Dialog close on overlay click
    elements.dialogOverlay.addEventListener('click', (e) => {
      if (e.target === elements.dialogOverlay) {
        elements.dialogOverlay.classList.remove('show');
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideDdDialog();
        hideContextMenu();
        hideTreeContextMenu();
        return;
      }
      if (e.target.tagName === 'INPUT') return;

      const pane = state.activePane;
      const p = state.panes[pane];

      if (e.key === 'Delete' && p.selectedItem) {
        handleContextAction('delete');
      } else if (e.key === 'F2' && p.selectedItem) {
        showRenameDialog(p.selectedItem);
      } else if (e.key === 'F5' && p.selectedItem) {
        handleContextAction('copy');
      } else if (e.key === 'F6' && p.selectedItem) {
        handleContextAction('move');
      } else if (e.key === 'F7') {
        showMkdirDialog();
      } else if (e.key === 'F8') {
        if (state.clipboard) {
          handleContextAction('paste');
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        state.activePane = state.activePane === 'top' ? 'bottom' : 'top';
        updatePaneLabel();
      }
    });

    // Click on empty area / Drop on pane background
    ['top', 'bottom'].forEach(pane => {
      const wrapper = $(`.file-list-wrapper[data-pane="${pane}"]`);

      wrapper.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-servex-paths')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      });

      wrapper.addEventListener('drop', (e) => {
        if (e.target.closest('.file-item')) return; // handled by file-item drop
        const pathsRaw = e.dataTransfer.getData('application/x-servex-paths');
        if (!pathsRaw) return;
        e.preventDefault();
        let sourcePaths;
        try { sourcePaths = JSON.parse(pathsRaw); } catch (_) { return; }
        const destPath = state.panes[pane].currentPath;
        if (!sourcePaths.length) return;
        showDdDialog(sourcePaths, destPath);
      });

      wrapper.addEventListener('click', (e) => {
        if (e.target === wrapper || e.target.classList.contains('file-list')) {
          state.activePane = pane;
          updatePaneLabel();
          // Deselect
          const p = state.panes[pane];
          p.selectedItem = null;
          p.selectedItems.clear();
          const container = pane === 'top' ? elements.fileListTop : elements.fileListBottom;
          container.querySelectorAll('.file-item').forEach(i => i.classList.remove('selected', 'multi-selected'));
          updateInfoPanel(null);
          updateItemCount(pane);
        }
      });

      wrapper.addEventListener('contextmenu', (e) => {
        if (e.target === wrapper || e.target.classList.contains('file-list')) {
          e.preventDefault();
          state.activePane = pane;
          updatePaneLabel();
          // Show paste option
          const svgPaste = '<svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
          const svgMkdir = '<svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>';
          const svgFile = '<svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
          elements.contextMenu.innerHTML = state.clipboard
            ? `<div class="menu-item" data-action="paste">${svgPaste} 貼り付け (${state.clipboard.paths.length}件)</div>
               <div class="menu-divider"></div>
               <div class="menu-item" data-action="mkdir">${svgMkdir} フォルダ作成</div>
               <div class="menu-item" data-action="createfile">${svgFile} ファイル作成</div>`
            : `<div class="menu-item" data-action="mkdir">${svgMkdir} フォルダ作成</div>
               <div class="menu-item" data-action="createfile">${svgFile} ファイル作成</div>`;
          elements.contextMenu.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => handleContextAction(item.dataset.action));
          });
          showContextMenu(e.clientX, e.clientY);
        }
      });
    });
  }

  function updatePaneLabel() {
    const label = $('#pane-label');
    label.textContent = state.activePane === 'top' ? '上ペイン (Tab: 切替)' : '下ペイン (Tab: 切替)';
    renderTree();
  }

  // ── Initialize ──
  function init() {
    initResize();
    initLeftSidebarResize();
    initEventListeners();
    loadTree('top', '');
    loadTree('bottom', '');
    navigateTo('top', '/');
    navigateTo('bottom', '/');
    updatePaneLabel();
  }

  init();
})();
