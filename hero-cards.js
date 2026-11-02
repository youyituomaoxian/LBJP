/* LBJP · Hero 弧形卡片轮播（书18）
 * 参考 Reelmark hero 曲面卡带：12 张提示词卡片持续右→左漂移（可无缝循环），
 * 指针/触摸可拖拽 1:1 跟手，松手后惯性滑行（速度约 95%/秒衰减）并缓回自动滚动；
 * 卡片几何按「圆柱内壁」推挤——越靠视口边缘越宽越高、外缘高于内缘，
 * 圆角四边形每帧用 clip-path: path() 重算。无投影、无描边，靠图面与曲面本身成型。
 *
 * 数据：与图库同一份 data/entries.json，均匀抽样 12 条（首尾覆盖全库，不偏最新）；
 * 点击卡片走 PromptLib.openDetail 打开与瀑布流同款详情弹窗。
 * 健壮性：fetch 失败 / file:// 直开走 data/*.js 孪生；再失败整段隐藏，绝不白屏。
 * 动效：prefers-reduced-motion 时不自动滚动（仍可拖拽）；页外不空转（IntersectionObserver 门控）。
 */
(function () {
  'use strict';
  var doc = document;
  var section = doc.getElementById('hero-reels');
  if (!section) return;
  var band = section.querySelector('.reel-band');
  if (!band) return;

  var view = doc.defaultView || window;
  var reduceQuery = view.matchMedia ? view.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(reduceQuery && reduceQuery.matches); }

  // ---------- 数据载入（与 app.js loadJSON 同双通道）----------
  function bust(path) { return path + '?t=' + Date.now(); }
  function loadJSON(path, key) {
    if (doc.location && doc.location.protocol === 'file:') {
      return new Promise(function (resolve, reject) {
        var s = doc.createElement('script');
        s.src = path.replace(/\.json$/, '.js');
        s.onload = function () {
          var bag = view.__TM_DATA__;
          if (bag && bag[key] !== undefined) resolve(bag[key]);
          else reject(new Error('数据孪生为空: ' + key));
        };
        s.onerror = function () { reject(new Error('数据文件缺失: ' + path)); };
        (doc.head || doc.documentElement).appendChild(s);
      });
    }
    return fetch(bust(path), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // 缩略图约定与 app.js thumbOf 一致（SVG 矢量不产缩略图 → 原图直出）
  function thumbOf(url) {
    var m = /^(.*\/)([^/]+)$/.exec(String(url || ''));
    if (!m || /\.svg$/i.test(url)) return url;
    return m[1] + 'thumb-' + m[2];
  }

  // ---------- 卡片 DOM ----------
  var cardEls = [];
  var ENTRY_BY_INDEX = [];          // 卡槽 → 条目（拖拽循环后仍可定位）
  var ENTRIES = [];                 // 给 openDetail 用的全量条目
  var DIMS = {};

  // 点击开详情：与瀑布流同一弹窗（PromptLib.openDetail）。
  // 必须复用 boot 的**同一状态实例**（getBootState）——closeDetail 有 `!st.openId` 守卫，
  // 另立 state 会导致弹窗关不掉（书18b 实测踩过）；boot 状态的 entries 由首渲填好，
  // 万一还没就绪（极端时序）才回退用轮播自己拉的数据。
  function openEntryById(id) {
    if (!view.PromptLib || !view.PromptLib.openDetail) return;
    var st = view.PromptLib.getBootState ? view.PromptLib.getBootState() : null;
    if (!st) st = view.PromptLib.state(doc);
    if (!st.entries || !st.entries.length) { st.entries = ENTRIES; st.dims = DIMS; }
    view.PromptLib.openDetail(doc, st, id);
  }

  function buildCards(picks) {
    band.innerHTML = '';
    cardEls = [];
    ENTRY_BY_INDEX = picks.slice();
    picks.forEach(function (e, i) {
      var card = doc.createElement('article');
      card.className = 'reel-card';
      card.setAttribute('data-id', e.id);
      var inner = doc.createElement('div');
      inner.className = 'reel-inner';
      inner.style.animationDelay = (i % 12) * 55 + 'ms';
      var img = doc.createElement('img');
      img.alt = e.title || '';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('load', function () { img.classList.add('is-loaded'); });
      img.addEventListener('error', function () {
        // 缩略图缺失 → 回退原图（与图库同一兜底口径），再失败显示骨架底色
        if (img.src !== e.images[0] && img.getAttribute('src') !== e.images[0]) img.src = e.images[0];
      });
      img.src = thumbOf(e.images[0]);
      var icon = doc.createElement('span');
      icon.className = 'reel-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none">' +
        '<path d="M3 9 9 3M4.2 3H9v4.8" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var chip = doc.createElement('span');
      chip.className = 'reel-chip';
      chip.textContent = e.title || '';
      inner.appendChild(img);
      inner.appendChild(icon);
      inner.appendChild(chip);
      card.appendChild(inner);
      // 点击走 pointerup 命中检测（见 endDrag）：setPointerCapture 会把 click 事件
      // 重定向到 band，卡片自身的 click 监听收不到 —— 实测踩过。
      // 键盘可及性：卡片可聚焦，Enter/Space 同样开弹窗。
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', '查看提示词：' + (e.title || ''));
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEntryById(e.id); }
      });
      band.appendChild(card);
      cardEls.push(card);
    });
  }

  // ---------- 几何：圆柱内壁曲面 ----------
  // 设计基准（单位 u = 缩放系数）：卡距 196 / 基础卡 170×280 / 边缘增高 110·d^2.6 /
  // 中线下沉 14·d² / 中心外推 1 + 0.10·d² / 圆角 15u。d = 距视口中心归一化距离。
  // 书18d：透视加强——EDGE_ADD 92→110、宽度外扩 48→58、外推 0.083→0.10、下沉 12→14
  // （同步放大，边缘间隙不塌）；边缘卡明显更高更宽、外倾更夸张。
  var PITCH = 196, BASE_W = 170, BASE_H = 280, EDGE_ADD = 110, EDGE_POW = 2.6,
      DIP = 14, PUSH = 0.10, RADIUS = 15, CANVAS_W = 1440;
  var u = 1;
  function clampD(v) { return Math.min(Math.abs(v), 1.25); }

  // 圆角四边形 path（四角用二次贝塞尔圆角，直边允许微斜 → 卡片「外倾」感）
  function roundedPath(pts, r) {
    var n = pts.length, d = '';
    for (var i = 0; i < n; i++) {
      var p = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
      var v1x = prev[0] - p[0], v1y = prev[1] - p[1];
      var v2x = next[0] - p[0], v2y = next[1] - p[1];
      var l1 = Math.sqrt(v1x * v1x + v1y * v1y) || 1;
      var l2 = Math.sqrt(v2x * v2x + v2y * v2y) || 1;
      var r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
      var ax = (p[0] + v1x / l1 * r1).toFixed(2), ay = (p[1] + v1y / l1 * r1).toFixed(2);
      var bx = (p[0] + v2x / l2 * r2).toFixed(2), by = (p[1] + v2y / l2 * r2).toFixed(2);
      d += (i ? 'L' : 'M') + ax + ' ' + ay +
           ' Q' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ' ' + bx + ' ' + by + ' ';
    }
    return d + 'Z';
  }

  function layout(offsetPx) {
    var bw = band.clientWidth || 1;
    var half = bw / 2;
    var total = cardEls.length * PITCH * u;
    for (var i = 0; i < cardEls.length; i++) {
      var card = cardEls[i];
      // 包裹到 [-total/2, total/2) → 无缝循环
      var t = i * PITCH * u + offsetPx;
      t = ((t % total) + total) % total - total / 2;
      var dn = clampD(t / half);
      // 中心外推（边缘间距不塌）+ 宽度外扩
      var x = half + t * (1 + PUSH * dn * dn);
      var w = (BASE_W + 58 * dn * dn) * u;
      // 左右边缘各自的高度（外缘 > 内缘 → 倾斜感）
      var dL = clampD((x - w / 2 - half) / half);
      var dR = clampD((x + w / 2 - half) / half);
      var hL = (BASE_H + EDGE_ADD * Math.pow(dL, EDGE_POW)) * u;
      var hR = (BASE_H + EDGE_ADD * Math.pow(dR, EDGE_POW)) * u;
      var H = Math.max(hL, hR);
      var cy = band.clientHeight / 2 - DIP * u * dn * dn;
      card.style.width = w.toFixed(2) + 'px';
      card.style.height = H.toFixed(2) + 'px';
      card.style.transform = 'translate(' + (x - w / 2).toFixed(2) + 'px,' + (cy - H / 2).toFixed(2) + 'px)';
      card.style.clipPath = 'path("' + roundedPath([
        [0, (H - hL) / 2], [w, (H - hR) / 2], [w, (H + hR) / 2], [0, (H + hL) / 2]
      ], RADIUS * u) + '")';
    }
  }

  // ---------- 时钟：自动滚动 + 拖拽 + 惯性 ----------
  var AUTO_SPEED = 50;                 // 单位/秒（u 缩放后 ≈ 慢速漂移）
  var offset = 0, velocity = 0, mode = 'auto';   // auto | drag | coast
  var dragging = false;
  var lastPtrX = 0, downX = 0, downY = 0, moved = 0;
  var visible = true;

  var rafId = 0, lastTs = 0;
  function frame(ts) {
    rafId = 0;
    if (!lastTs) lastTs = ts;
    var dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;
    if (visible && cardEls.length) {
      if (!reduced()) {
        if (mode === 'auto') {
          offset -= AUTO_SPEED * u * dt;
        } else if (mode === 'coast') {
          // 惯性向自动滚动速度收口（≈95%/秒衰减）
          var target = -AUTO_SPEED * u;
          velocity = target + (velocity - target) * Math.pow(0.05, dt);
          offset += velocity * dt;
          if (Math.abs(velocity - target) < 2) mode = 'auto';
        }
      }
      layout(offset);
    }
    rafId = requestAnimationFrame(frame);
  }
  function ensureLoop() {
    if (!rafId) { lastTs = 0; rafId = requestAnimationFrame(frame); }
  }

  // 页外不空转
  if (view.IntersectionObserver) {
    new IntersectionObserver(function (ents) {
      visible = ents[0] ? ents[0].isIntersecting : true;
    }, { rootMargin: '80px' }).observe(section);
  }

  // ---------- 拖拽（指针统一处理，含触摸）----------
  band.addEventListener('pointerdown', function (ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    dragging = true; mode = 'drag'; moved = 0;
    lastPtrX = ev.clientX; downX = ev.clientX; downY = ev.clientY;
    try { band.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
  });
  band.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    var dx = ev.clientX - lastPtrX;
    lastPtrX = ev.clientX;
    moved = Math.max(moved, Math.abs(ev.clientX - downX), Math.abs(ev.clientY - downY));
    offset += dx;                                   // 1:1 跟手
    velocity = dx * 60;                             // 粗略速度（px/s），松手时作惯性初速
  });
  function endDrag(ev) {
    if (!dragging) return;
    dragging = false;
    if (moved > 6) {                                  // 是拖拽不是点击 → 进惯性滑行
      mode = 'coast';
      return;
    }
    mode = 'coast';
    // 点击命中：capture 后 click 落在 band 上，故在 pointerup 用坐标反查卡片。
    // 卡片 clip-path 裁掉了圆角外区域，elementFromPoint 对裁掉区仍会命中 ——
    // 四角极小 + 圆角过渡，可接受；不额外做几何反算。
    if (ev && typeof ev.clientX === 'number' && doc.elementFromPoint) {
      var hit = doc.elementFromPoint(ev.clientX, ev.clientY);
      var card = hit && hit.closest ? hit.closest('.reel-card') : null;
      if (card) openEntryById(card.getAttribute('data-id'));
    }
  }
  band.addEventListener('pointerup', endDrag);
  band.addEventListener('pointercancel', function () { dragging = false; mode = 'coast'; });
  // 拖拽中禁止原生图片拖影 / 文本选中
  band.addEventListener('dragstart', function (ev) { ev.preventDefault(); });

  // ---------- 尺寸 ----------
  function resize() {
    var bw = band.clientWidth || view.innerWidth;
    // 书18d：瀑布流只露一点点（提示够用），省出的高度还给卡带——桌面 u 0.58→0.63、
    // 高度系数 396→410（透视加强后边缘卡更高，容得下）；≤820 移动端仍保底 0.62
    var narrow = view.matchMedia ? view.matchMedia('(max-width: 820px)').matches : bw <= 820;
    u = Math.max(bw / CANVAS_W * 0.63, narrow ? 0.62 : 0.42);
    band.style.height = Math.round(410 * u) + 'px';
    layout(offset);
  }
  var resizeTimer = 0;
  view.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });
  if (reduceQuery && reduceQuery.addEventListener) {
    reduceQuery.addEventListener('change', function () { mode = 'auto'; });
  }

  // ---------- 启动 ----------
  Promise.all([
    loadJSON('data/entries.json', 'entries'),
    loadJSON('data/image-dims.json', 'image-dims').catch(function () { return {}; })
  ]).then(function (all) {
    var entries = all[0], dims = all[1] || {};
    if (!Array.isArray(entries) || !entries.length) return Promise.reject(new Error('empty'));
    ENTRIES = entries;
    DIMS = dims;
    // 均匀抽样 12 条：覆盖全库首尾，类别自然错开
    var withImg = entries.filter(function (e) { return e && e.images && e.images.length; });
    var n = Math.min(12, withImg.length);
    var picks = [];
    for (var i = 0; i < n; i++) picks.push(withImg[Math.floor(i * withImg.length / n) % withImg.length]);
    section.classList.add('is-ready');
    buildCards(picks);
    resize();
    ensureLoop();
  }).catch(function () {
    // 数据不可达：整段退场，页面其余部分零影响
    section.style.display = 'none';
  });
})();
