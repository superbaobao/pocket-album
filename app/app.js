/* Media Viewer — static gallery for a USB drive of photos/videos.
   Runs from file:// — no build, no server. Data comes from media-index.js. */
(function () {
  'use strict';

  var DATA = window.MEDIA_INDEX || { items: [], dirs: [], root: 'Media', counts: {} };
  var ALL = DATA.items;

  var state = {
    dir: '',
    recursive: true,
    sort: 'time-asc',        // time-asc (default) | time-desc | name
    media: 'all',            // all (default) | image | video
    query: '',
    view: [],                // filtered items
    shown: 0,                // how many rendered into the grid
    sel: -1,                 // selected tile index (grid keyboard nav)
    pane: 'tree',            // which pane the arrow keys drive: 'tree' | 'grid'
  };
  var CHUNK = 80;

  var $ = function (id) { return document.getElementById(id); };
  function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function isMobile() { return window.matchMedia('(max-width: 760px)').matches; }
  function isTouch() { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; }

  // Name shown top-left. From a USB the file path is /Volumes/<卷名>/index.html (macOS)
  // or /<盘符>:/index.html (Windows) — so the folder holding index.html IS the volume name.
  // Falls back to the build-time folder name when the path can't be read (e.g. served over http).
  function displayRoot() {
    try {
      if (location.protocol === 'file:') {
        var p = decodeURIComponent(location.pathname).replace(/\/+$/, '');
        p = p.replace(/\/[^\/]*$/, '');                 // drop the index.html filename
        var seg = p.split('/').filter(Boolean).pop();
        if (seg && !/^[a-zA-Z]:$/.test(seg)) return seg;   // skip bare Windows drive letters (E:) → use baked name
      }
    } catch (e) {}
    return DATA.root || 'Media';
  }

  /* ---------- filtering / sorting ---------- */
  function inDir(it) {
    if (!state.dir) return true;
    if (state.recursive) return it.dir === state.dir || it.dir.indexOf(state.dir + '/') === 0;
    return it.dir === state.dir;
  }
  function applyFilter() {
    var q = state.query.trim().toLowerCase();
    state.view = ALL.filter(function (it) {
      if (!inDir(it)) return false;
      if (state.media !== 'all' && it.type !== state.media) return false;   // 照片 / 视频 筛选
      // match the full relative path so directory names are searchable too
      // (folder names usually carry the meaning, filenames often don't)
      if (q && it.path.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    if (state.sort === 'name') {
      state.view.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    } else if (state.sort === 'time-asc') {
      state.view.sort(function (a, b) { return a.time - b.time || a.path.localeCompare(b.path); });
    } else {
      state.view.sort(function (a, b) { return b.time - a.time || a.path.localeCompare(b.path); });
    }
    state.shown = 0;
    state.sel = -1;
    $('locateBtn').disabled = true;
    $('grid').innerHTML = '';
    $('empty').hidden = state.view.length > 0;
    renderMore();
    refreshNav();
  }

  /* ---------- grid ---------- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var img = e.target;
      io.unobserve(img);
      img.src = img.dataset.src;
    });
  }, { rootMargin: '600px 0px' });

  function fmtDate(ms) {
    try {
      var d = new Date(ms);
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    } catch (e) { return ''; }
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }

  function makeTile(it, index) {
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.index = index;

    var img = document.createElement('img');
    img.alt = it.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', function () { img.classList.add('loaded'); });

    if (it.type === 'image') {
      img.dataset.src = enc(it.thumb || it.path);
    } else {
      // video: try a cached/in-browser poster, else a neutral placeholder
      img.dataset.src = TRANSPARENT;
      var play = document.createElement('div');
      play.className = 'vplay';
      play.innerHTML = '<span></span>';
      tile.appendChild(play);
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = (it.path.split('.').pop() || 'video').toUpperCase();
      tile.appendChild(badge);
      requestPoster(it, img);
    }
    tile.insertBefore(img, tile.firstChild);
    io.observe(img);
    // touch: single tap opens fullscreen. desktop: single click selects, double-click opens.
    tile.addEventListener('click', function () {
      state.pane = 'grid';
      if (isTouch()) openLightbox(index); else selectTile(index);
    });
    tile.addEventListener('dblclick', function () { openLightbox(index); });
    return tile;
  }

  function gridCols() {
    var cols = getComputedStyle($('grid')).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  }
  function selectTile(i, keepScroll) {
    if (!state.view.length) return;
    i = Math.max(0, Math.min(i, state.view.length - 1));
    while (state.shown <= i && state.shown < state.view.length) renderMore();
    var prev = $('grid').querySelector('.tile.sel');
    if (prev) prev.classList.remove('sel');
    state.sel = i;
    var el = $('grid').querySelector('.tile[data-index="' + i + '"]');
    if (el) { el.classList.add('sel'); if (!keepScroll) el.scrollIntoView({ block: 'nearest' }); }
    $('locateBtn').disabled = false;
  }

  // reveal the selected photo's folder in the directory tree (keep the photo selected)
  function locateInTree() {
    if (state.sel < 0) return;
    var item = state.view[state.sel];
    if (!item) return;
    var path = item.path;
    selectDir(item.dir);                  // expand/highlight the tree to that folder + show its photos
    var idx = -1;
    for (var k = 0; k < state.view.length; k++) { if (state.view[k].path === path) { idx = k; break; } }
    if (idx >= 0) { state.pane = 'grid'; selectTile(idx); }
  }

  function renderMore() {
    var frag = document.createDocumentFragment();
    var end = Math.min(state.shown + CHUNK, state.view.length);
    for (var i = state.shown; i < end; i++) frag.appendChild(makeTile(state.view[i], i));
    $('grid').appendChild(frag);
    state.shown = end;
  }

  var sentinelIO = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting && state.shown < state.view.length) renderMore();
  }, { rootMargin: '800px 0px' });

  /* ---------- video posters (in-browser, cached in IndexedDB) ---------- */
  var TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  var posterQueue = [];
  var posterBusy = 0;

  function requestPoster(it, img) {
    idbGet(it.path).then(function (cached) {
      if (cached) { img.dataset.src = cached; if (isInView(img)) img.src = cached; return; }
      posterQueue.push({ it: it, img: img });
      pumpPosters();
    });
  }
  function isInView(img) { return img.src && img.src !== TRANSPARENT && img.src.length > 50; }

  function pumpPosters() {
    while (posterBusy < 2 && posterQueue.length) {
      var job = posterQueue.shift();
      posterBusy++;
      grabPoster(job.it).then(function (data) {
        posterBusy--;
        if (data) {
          idbSet(job.it.path, data);
          job.img.dataset.src = data;
          job.img.src = data;
        }
        pumpPosters();
      }).catch(function () { posterBusy--; pumpPosters(); });
    }
  }

  function grabPoster(it) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      v.muted = true; v.preload = 'metadata'; v.crossOrigin = 'anonymous';
      v.src = enc(it.path);
      var done = false;
      function fail() { if (!done) { done = true; cleanup(); resolve(null); } }
      function cleanup() { v.removeAttribute('src'); try { v.load(); } catch (e) {} }
      var timer = setTimeout(fail, 8000);
      v.addEventListener('loadeddata', function () {
        try { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); } catch (e) { fail(); }
      });
      v.addEventListener('seeked', function () {
        if (done) return;
        try {
          var w = v.videoWidth, h = v.videoHeight;
          if (!w || !h) return fail();
          var scale = Math.min(1, 480 / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          var data = c.toDataURL('image/jpeg', 0.7);
          done = true; clearTimeout(timer); cleanup();
          resolve(data);
        } catch (e) { fail(); }
      });
      v.addEventListener('error', fail);
    });
  }

  /* tiny IndexedDB key/value for posters */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      var r = indexedDB.open('mv-posters', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('p'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { resolve(null); };
    });
    return dbp;
  }
  function idbGet(k) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try {
          var t = d.transaction('p', 'readonly').objectStore('p').get(k);
          t.onsuccess = function () { res(t.result || null); };
          t.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  }
  function idbSet(k, v) {
    return db().then(function (d) {
      if (!d) return;
      try { d.transaction('p', 'readwrite').objectStore('p').put(v, k); } catch (e) {}
    });
  }

  /* ---------- sidebar tree (collapsible) ---------- */
  var tree = { counts: {}, kids: {}, expanded: { '': true } };

  function buildTree() {
    var counts = {};                       // dir -> recursive media count
    ALL.forEach(function (it) {
      counts[''] = (counts[''] || 0) + 1;
      var d = it.dir;
      while (d) { counts[d] = (counts[d] || 0) + 1; d = d.indexOf('/') >= 0 ? d.slice(0, d.lastIndexOf('/')) : ''; }
    });
    var kids = {};                         // parentDir -> [childDir]
    DATA.dirs.forEach(function (d) {
      var parent = d.indexOf('/') >= 0 ? d.slice(0, d.lastIndexOf('/')) : '';
      (kids[parent] = kids[parent] || []).push(d);
    });
    tree.counts = counts;
    tree.kids = kids;
    renderTree();
  }

  var ROW_H = 26;                          // sticky header height (single line), px

  function renderTree() {
    var box = $('tree');
    box.innerHTML = '';
    box.appendChild(folderRow('', '所有照片视频', 0));
    appendKids(box, '', 1);
    highlight();
  }
  function appendKids(box, parent, depth) {
    if (!tree.expanded[parent] || !tree.kids[parent]) return;
    tree.kids[parent].forEach(function (d) {
      var label = d.slice(d.lastIndexOf('/') + 1);
      if (tree.kids[d] && tree.expanded[d]) {
        // expanded folder: wrap its header + children so the header pins only while
        // its own subtree is on screen (sticky ancestor)
        var group = document.createElement('div');
        group.className = 'tree-group';
        group.appendChild(folderRow(d, label, depth));
        appendKids(group, d, depth + 1);
        box.appendChild(group);
      } else {
        box.appendChild(folderRow(d, label, depth));
      }
    });
  }
  function folderRow(dir, label, depth) {
    var hasKids = !!tree.kids[dir];
    var isRoot = dir === '';
    var open = !!tree.expanded[dir];
    var sticky = isRoot || (hasKids && open);  // ancestors-in-view stay pinned
    var el = document.createElement('div');
    el.className = 'node' + (sticky ? ' sticky' : '') + (isRoot ? ' rootnode' : '');
    el.dataset.dir = dir;
    el.title = dir || label;
    el.style.paddingLeft = (8 + depth * 14) + 'px';
    if (sticky) { el.style.top = (depth * ROW_H) + 'px'; el.style.zIndex = String(50 - depth); }
    el.innerHTML = '<span class="twist"></span><span class="label"></span><span class="n">' +
      (tree.counts[dir] || 0) + '</span>';
    var tw = el.querySelector('.twist');
    tw.textContent = isRoot ? '' : hasKids ? (open ? '▼' : '▶') : '•';
    if (!isRoot && !hasKids) tw.classList.add('leaf');
    el.querySelector('.label').textContent = label;
    if (hasKids && !isRoot) {
      tw.classList.add('clickable');
      tw.addEventListener('click', function (e) {
        e.stopPropagation();                 // fold/unfold without changing the selected folder
        tree.expanded[dir] = !tree.expanded[dir];
        renderTree();
      });
    }
    el.addEventListener('click', function () {
      if (dir !== '' && state.dir === dir && tree.expanded[dir]) {
        tree.expanded[dir] = false;   // second click on the already-open folder → collapse
        renderTree(); refreshNav();
      } else {
        selectDir(dir);               // first click → show photos + accordion-expand
      }
      if (isMobile()) document.getElementById('app').classList.add('nav-collapsed');
    });
    return el;
  }
  function highlight() {
    [].forEach.call(document.querySelectorAll('.node'), function (n) {
      n.classList.toggle('active', n.dataset.dir === state.dir);
    });
  }

  /* ---------- directory navigation (keyboard + buttons) ---------- */

  // accordion: expand only the path root → d (so d's subfolders show), collapse every other branch
  function expandPath(d) {
    var exp = { '': true };
    if (d) {
      var parts = d.split('/'), acc = '';
      for (var i = 0; i < parts.length; i++) { acc = acc ? acc + '/' + parts[i] : parts[i]; exp[acc] = true; }
    }
    tree.expanded = exp;
  }
  function selectDir(d) {
    state.dir = d;
    state.pane = 'tree';
    expandPath(d);                  // accordion: reveal d's subfolders, fold other branches
    renderTree();                   // rebuild tree + re-highlight
    applyFilter();                  // re-renders grid + refreshes the nav bar
    ensureVisible(d);
    $('main').scrollTop = 0;
  }
  function ensureVisible(d) {
    var nodes = $('tree').querySelectorAll('.node');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].dataset.dir === d) { nodes[i].scrollIntoView({ block: 'nearest' }); return; }
    }
  }
  // list of currently-visible folders in top-to-bottom order (the rendered tree rows)
  function visibleDirs() {
    return [].slice.call($('tree').querySelectorAll('.node')).map(function (n) { return n.dataset.dir; });
  }
  // move focus (show photos) WITHOUT reshuffling the tree — keyboard/buttons don't auto-expand
  function focusDir(d) {
    state.dir = d;
    state.pane = 'tree';
    applyFilter();        // grid + breadcrumb + button states
    highlight();
    ensureVisible(d);
    $('main').scrollTop = 0;
  }
  function treeMove(delta) {            // ↑/↓ : move through visible rows (ignoring level boundaries)
    var dirs = visibleDirs();
    var i = dirs.indexOf(state.dir);
    if (i < 0) { if (dirs.length) focusDir(dirs[0]); return; }
    var n = i + delta;
    if (n >= 0 && n < dirs.length) focusDir(dirs[n]);
  }
  function parentOf(d) { return d.indexOf('/') >= 0 ? d.slice(0, d.lastIndexOf('/')) : ''; }
  function treeCollapse() {            // keyboard ← : collapse the current folder (never the root)
    if (state.dir && tree.kids[state.dir] && tree.expanded[state.dir]) { tree.expanded[state.dir] = false; renderTree(); refreshNav(); }
  }
  function treeExpand() {              // keyboard → : expand the current folder
    if (tree.kids[state.dir] && !tree.expanded[state.dir]) { tree.expanded[state.dir] = true; renderTree(); refreshNav(); }
  }
  function treeToggle() {              // button 4 : toggle expand / collapse of the current folder
    if (tree.expanded[state.dir]) treeCollapse(); else treeExpand();
  }
  // up one level, keeping the view from jumping: anchor on the selected photo, or
  // (if none selected) on the topmost photo currently visible, holding its screen row.
  function goParent() {
    if (state.dir === '') return;
    var anchorPath = null, anchorTop = null, hadSel = state.sel >= 0;
    if (hadSel) {
      var selEl = $('grid').querySelector('.tile.sel');
      if (selEl) { anchorPath = state.view[state.sel].path; anchorTop = selEl.getBoundingClientRect().top; }
    } else {
      var thresh = document.querySelector('.crumbbar').getBoundingClientRect().bottom;
      var tiles = $('grid').querySelectorAll('.tile');
      for (var t = 0; t < tiles.length; t++) {
        var r = tiles[t].getBoundingClientRect();
        if (r.bottom > thresh + 4) { anchorPath = state.view[+tiles[t].dataset.index].path; anchorTop = r.top; break; }
      }
    }
    focusDir(parentOf(state.dir));    // parent is recursive, so the anchor photo is still in the list
    if (anchorPath == null) return;
    var idx = -1;
    for (var k = 0; k < state.view.length; k++) { if (state.view[k].path === anchorPath) { idx = k; break; } }
    if (idx < 0) return;
    while (state.shown <= idx && state.shown < state.view.length) renderMore();
    var el = $('grid').querySelector('.tile[data-index="' + idx + '"]');
    if (el) $('main').scrollTop += el.getBoundingClientRect().top - anchorTop;   // hold the same row
    if (hadSel) { state.pane = 'grid'; selectTile(idx, true); }                  // re-select only if it was selected
  }
  function refreshNav() {
    var cur = state.dir;
    var hasKids = !!(tree.kids[cur] && tree.kids[cur].length);
    var expanded = !!tree.expanded[cur];
    var dirs = visibleDirs();
    var i = dirs.indexOf(cur);
    $('navUp').disabled = (cur === '');                    // 上一层
    $('navPrev').disabled = i <= 0;                         // ↑ 移动
    $('navNext').disabled = i < 0 || i >= dirs.length - 1;  // ↓ 移动
    $('navInto').disabled = !(cur && hasKids);             // 展开/收起 (not for root)
    $('navInto').textContent = expanded ? '收起' : '展开';
    buildCrumb(cur);
  }
  function buildCrumb(cur) {
    var box = $('navPath');
    box.innerHTML = '';
    var parts = cur === '' ? [] : cur.split('/');
    box.appendChild(crumbEl('所有照片视频', '', parts.length === 0));
    var acc = '';
    parts.forEach(function (seg, idx) {
      var sep = document.createElement('span');
      sep.className = 'crumb-sep'; sep.textContent = '›';
      box.appendChild(sep);
      acc = acc ? acc + '/' + seg : seg;
      box.appendChild(crumbEl(seg, acc, idx === parts.length - 1));
    });
  }
  function crumbEl(label, dir, current) {
    var el = document.createElement('span');
    el.className = 'crumb' + (current ? ' current' : '');
    el.textContent = label;
    el.title = dir || label;
    if (!current) el.addEventListener('click', function () { selectDir(dir); });
    return el;
  }

  /* ---------- lightbox ---------- */
  var lbIndex = -1;
  function openLightbox(i) {
    lbIndex = i;
    $('lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
    showLb();
  }
  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lbStage').innerHTML = '';
    document.body.style.overflow = '';
    var i = lbIndex;
    lbIndex = -1;
    if (i >= 0) { state.pane = 'grid'; selectTile(i); }   // keep selection on the photo you were viewing
  }
  function step(d) {
    var n = lbIndex + d;
    if (n < 0 || n >= state.view.length) return;
    lbIndex = n; showLb();
  }
  function showLb() {
    var it = state.view[lbIndex];
    var stage = $('lbStage');
    stage.innerHTML = '';
    if (it.type === 'video') {
      var v = document.createElement('video');
      v.src = enc(it.path); v.controls = true; v.autoplay = true; v.playsInline = true;
      v.setAttribute('playsinline', '');
      stage.appendChild(v);
    } else {
      var img = document.createElement('img');
      img.src = enc(it.web || it.path);            // web JPEG for HEIC/TIFF, else original
      img.alt = it.name;
      stage.appendChild(img);
    }
    var dl = $('lbDownload');               // always the ORIGINAL file (e.g. the .heic, not the web JPG)
    dl.href = enc(it.path);
    dl.setAttribute('download', it.name);
    $('lbCounter').textContent = (lbIndex + 1) + ' / ' + state.view.length;
    $('lbInfo').innerHTML = '<span class="nm"></span><span class="dt">' + fmtDate(it.time) +
      (it.dir ? '  ·  ' + it.dir : '') + '</span>';
    $('lbInfo').querySelector('.nm').textContent = it.name;
    $('lbPrev').style.visibility = lbIndex > 0 ? '' : 'hidden';
    $('lbNext').style.visibility = lbIndex < state.view.length - 1 ? '' : 'hidden';
  }

  /* swipe on the lightbox stage */
  function wireSwipe() {
    var sx = 0, sy = 0, t = 0;
    var lb = $('lightbox');
    lb.addEventListener('touchstart', function (e) {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; t = Date.now();
    }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      if (Date.now() - t > 600) return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1);
      else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
    }, { passive: true });
  }

  /* ---------- controls ---------- */
  var SORTS = [
    { key: 'time-asc', label: '时间 早→晚' },
    { key: 'time-desc', label: '时间 晚→早' },
    { key: 'name', label: '文件名' },
  ];
  var MEDIA = [
    { key: 'all', label: '照片+视频' },
    { key: 'image', label: '照片' },
    { key: 'video', label: '视频' },
  ];
  function labelOf(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    return list[0].label;
  }
  function cycle(list, current) {
    var i = 0;
    for (var k = 0; k < list.length; k++) if (list[k].key === current) i = k;
    return list[(i + 1) % list.length].key;
  }
  function cycleSort() {
    state.sort = cycle(SORTS, state.sort);
    $('sortLabel').textContent = labelOf(SORTS, state.sort);
    applyFilter();
  }
  function cycleMedia() {
    state.media = cycle(MEDIA, state.media);
    $('mediaLabel').textContent = labelOf(MEDIA, state.media);
    applyFilter();
  }

  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /* ---------- resizable directory pane ---------- */
  function setupResizer() {
    var MIN = 160, MAX = 600;
    function setW(w) {
      var max = Math.min(MAX, window.innerWidth - 280);   // always leave room for the gallery
      document.documentElement.style.setProperty('--sidebar-w', Math.min(max, Math.max(MIN, w)) + 'px');
    }
    try { var saved = parseInt(localStorage.getItem('mv-sidebar-w'), 10); if (saved) setW(saved); } catch (e) {}
    var dragging = false;
    $('resizer').addEventListener('mousedown', function (e) {
      dragging = true; e.preventDefault();
      document.body.classList.add('col-resizing');
      $('resizer').classList.add('dragging');
    });
    document.addEventListener('mousemove', function (e) {
      if (dragging) setW(e.clientX);   // sidebar starts at the left edge, so width ≈ cursor x
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('col-resizing');
      $('resizer').classList.remove('dragging');
      try { localStorage.setItem('mv-sidebar-w', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10)); } catch (e) {}
    });
  }

  function init() {
    var rootName = displayRoot();
    $('rootTitle').textContent = rootName;
    $('rootTitle').insertAdjacentHTML('beforeend',
      ' <span class="count">' + (DATA.counts.total || ALL.length) + ' 个图片和视频</span>');
    document.title = rootName + ' — Media Viewer';

    $('sortLabel').textContent = labelOf(SORTS, state.sort);     // reflect defaults
    $('mediaLabel').textContent = labelOf(MEDIA, state.media);

    buildTree();
    applyFilter();

    sentinelIO.observe($('sentinel'));

    $('sortBtn').addEventListener('click', cycleSort);
    $('mediaBtn').addEventListener('click', cycleMedia);
    $('locateBtn').addEventListener('click', locateInTree);
    $('search').addEventListener('input', debounce(function () {
      state.query = $('search').value; applyFilter();
    }, 180));

    setupResizer();
    // keep the sidebar responsive when the window is resized across the mobile breakpoint
    var mqMobile = window.matchMedia('(max-width: 760px)');
    function syncPane(m) {
      var app = document.getElementById('app');
      if (m.matches) app.classList.add('nav-collapsed');    // narrow → off-canvas drawer (hidden)
      else app.classList.remove('nav-collapsed');           // wide → docked sidebar (shown)
    }
    syncPane(mqMobile);
    mqMobile.addEventListener('change', syncPane);
    $('menuBtn').addEventListener('click', function () {
      document.getElementById('app').classList.toggle('nav-collapsed');
    });
    $('scrim').addEventListener('click', function () {
      document.getElementById('app').classList.add('nav-collapsed');
    });

    $('lbClose').addEventListener('click', closeLightbox);
    $('lbPrev').addEventListener('click', function () { step(-1); });
    $('lbNext').addEventListener('click', function () { step(1); });
    $('lightbox').addEventListener('click', function (e) {
      if (e.target === $('lightbox') || e.target === $('lbStage')) closeLightbox();
    });
    wireSwipe();

    $('navUp').addEventListener('click', goParent);          // 上一层
    $('navPrev').addEventListener('click', function () { treeMove(-1); });   // ↑
    $('navNext').addEventListener('click', function () { treeMove(1); });    // ↓
    $('navInto').addEventListener('click', treeToggle);      // 展开 / 收起

    document.addEventListener('keydown', function (e) {
      if (!$('lightbox').hidden) {                 // lightbox open: arrows switch photos (↑←prev, ↓→next)
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        return;
      }
      if (e.key === '/') { e.preventDefault(); $('search').focus(); return; }
      if (document.activeElement === $('search')) return;   // don't hijack typing
      if (state.pane === 'grid') {
        // gallery focused: arrows move the selected photo; Enter/Space opens it
        var cols = gridCols();
        var s = state.sel < 0 ? 0 : state.sel;
        if (e.key === 'ArrowLeft') { e.preventDefault(); selectTile(state.sel < 0 ? 0 : s - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); selectTile(state.sel < 0 ? 0 : s + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selectTile(state.sel < 0 ? 0 : s - cols); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); selectTile(state.sel < 0 ? 0 : s + cols); }
        else if (e.key === 'Enter' || e.key === ' ') { if (state.sel >= 0) { e.preventDefault(); openLightbox(state.sel); } }
        return;
      }
      // tree focused: ← collapse, → expand, ↑/↓ move through visible rows, Enter opens first photo
      if (e.key === 'Enter') { e.preventDefault(); if (state.view.length) openLightbox(0); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); treeCollapse(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); treeExpand(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); treeMove(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); treeMove(1); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
