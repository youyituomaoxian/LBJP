/* 留言管理 · 后台（自管模块，不改 admin.js 的条目逻辑）
 * ------------------------------------------------------------------
 * 查：读 data/messages.json（线上走 GitHub contents API / 本地走 /api/messages）
 * 删：按 id 过滤后整体写回同一个文件（写入即 commit，与站点「Git 当数据库」同口径）
 *
 * 凭证：线上 = sessionStorage['lbjp_gh_token']（管理员 PAT，admin.js 登录时写入）
 *       本地 = sessionStorage['lbjp_local_token']（/api/login 换来的会话令牌）
 * 本文件不新增任何凭据来源，也不把令牌写进 URL / localStorage / 日志。
 */
(function () {
  'use strict';

  var CFG = window.LBJP_FEEDBACK_CONFIG || {};
  var DATA_FILE = CFG.dataPath || 'data/messages.json';
  var GH_REPO = CFG.repo || 'youyituomaoxian/LBJP';
  var GH_BRANCH = CFG.branch || 'gh-pages';
  var TYPES = ['建议', '问题', '夸奖', '其他'];

  var $ = function (id) { return document.getElementById(id); };
  var all = [];            // 全量留言（最新在前）
  var sha = null;          // GitHub contents sha（写入需要；本地模式忽略）
  var picked = {};         // id -> true
  var viewOn = false;

  function q(name) {
    return new URLSearchParams(window.location.search || '').get(name);
  }
  function mode() {
    var forced = q('backend');
    if (forced === 'local' || forced === 'github') return forced;
    var h = String(window.location.hostname || '').toLowerCase();
    return (h === 'localhost' || h === '127.0.0.1') ? 'local' : 'github';
  }
  function repo() { return q('repo') || GH_REPO; }
  function branch() { return q('branch') || GH_BRANCH; }

  function token() {
    try {
      return sessionStorage.getItem(mode() === 'github' ? 'lbjp_gh_token' : 'lbjp_local_token') || '';
    } catch (e) { return ''; }
  }

  function setMsg(text, kind) {
    var n = $('fb-admin-msg');
    if (!n) return;
    n.textContent = text || '';
    n.className = 'fb-admin-msg' + (kind ? ' is-' + kind : '');
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '').slice(0, 16);
    try {
      return d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  function b64Utf8(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(bin);
  }
  function fromB64(b64) {
    var bin = atob(String(b64 || '').replace(/\n/g, ''));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(arr);
  }

  function normalize(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (m) {
      return m && typeof m === 'object' && String(m.id || '') && String(m.content || '').trim();
    }).map(function (m) {
      return {
        id: String(m.id).slice(0, 80),
        nickname: String(m.nickname || '匿名').slice(0, 20),
        type: TYPES.indexOf(m.type) >= 0 ? m.type : '其他',
        content: String(m.content).slice(0, 1000),
        page: String(m.page || '').slice(0, 120),
        createdAt: String(m.createdAt || '').slice(0, 40)
      };
    }).sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  function ghError(status, j) {
    var msg = (j && j.message) || ('HTTP ' + status);
    if (status === 401 || status === 403) return new Error('令牌无效或权限不足，请重新登录管理面板（' + msg + '）');
    if (status === 404) return new Error('仓库/分支/留言文件不存在（' + msg + '）');
    if (status === 409) return new Error('并发冲突：刚有人提交了新留言，请点「刷新」后重试');
    return new Error('GitHub API ' + status + '：' + msg);
  }

  function ghFetch(method, body) {
    var url = 'https://api.github.com/repos/' + repo() + '/contents/' + DATA_FILE +
      '?ref=' + encodeURIComponent(branch());
    return fetch(url, {
      method: method,
      headers: Object.assign({
        'Authorization': 'Bearer ' + token(),
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = ghError(r.status, j); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function localFetch(method, body) {
    return fetch('/api/messages', {
      method: method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token() ? { 'Authorization': 'Bearer ' + token() } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function readAll() {
    if (!token()) return Promise.reject(new Error('未登录：请先在管理面板完成登录'));
    if (mode() === 'local') {
      return localFetch('GET').then(function (j) {
        sha = null;
        return normalize(j.messages);
      });
    }
    return ghFetch('GET').then(function (j) {
      sha = j.sha || null;
      var text = fromB64(j.content);
      return normalize(JSON.parse(text || '[]'));
    }, function (e) {
      if (e.status === 404) { sha = null; return []; }   // 留言文件还没建 = 空列表
      throw e;
    });
  }

  function writeAll(messages, note) {
    var text = JSON.stringify(messages, null, 2) + '\n';
    if (mode() === 'local') {
      return localFetch('PUT', { messages: messages }).then(function () { return null; });
    }
    var body = {
      message: note,
      content: b64Utf8(text),
      branch: branch()
    };
    if (sha) body.sha = sha;
    return ghFetch('PUT', body).then(function (j) { return (j && j.content && j.content.sha) || null; },
      function (e) {
        if (e.status !== 409) throw e;
        // 别人刚提交过：重取 sha 再写一次
        return ghFetch('GET').then(function (j) {
          body.sha = j.sha;
          return ghFetch('PUT', body).then(function (r) { return (r && r.content && r.content.sha) || null; });
        });
      });
  }

  function visible() {
    var kw = String(($('fb-admin-search') && $('fb-admin-search').value) || '').trim().toLowerCase();
    var type = String(($('fb-admin-type') && $('fb-admin-type').value) || '');
    var sort = String(($('fb-admin-sort') && $('fb-admin-sort').value) || 'newest');
    var out = all.filter(function (m) {
      if (type && m.type !== type) return false;
      if (!kw) return true;
      return (m.content + ' ' + m.nickname + ' ' + m.page).toLowerCase().indexOf(kw) >= 0;
    });
    if (sort === 'oldest') out = out.slice().reverse();
    return out;
  }

  function bubble(parent, tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    parent.appendChild(n);
    return n;
  }

  function render() {
    var box = $('fb-admin-list');
    if (!box) return;
    var items = visible();
    box.textContent = '';

    var total = $('fb-admin-total');
    if (total) total.textContent = '共 ' + all.length + ' 条' + (items.length !== all.length ? '（筛出 ' + items.length + ' 条）' : '');
    var badge = $('fb-manage-count');
    if (badge) badge.textContent = String(all.length);
    renderPickBar(items);

    if (!items.length) {
      bubble(box, 'p', 'fb-admin-empty', all.length ? '没有符合条件的留言。' : '还没有留言。');
      return;
    }

    items.forEach(function (m) {
      var row = document.createElement('article');
      row.className = 'fb-admin-row';
      row.setAttribute('data-id', m.id);

      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !!picked[m.id];
      check.setAttribute('aria-label', '选中这条留言');
      check.addEventListener('change', function () {
        if (check.checked) picked[m.id] = true; else delete picked[m.id];
        renderPickBar(visible());
      });
      row.appendChild(check);

      var body = bubble(row, 'div', 'fb-admin-row-body');
      var meta = bubble(body, 'div', 'fb-admin-row-meta');
      bubble(meta, 'strong', 'fb-admin-row-nick', m.nickname);
      var badgeType = bubble(meta, 'span', 'fb-admin-badge', m.type);
      badgeType.setAttribute('data-type', m.type);
      bubble(meta, 'time', 'fb-admin-row-time', fmtTime(m.createdAt));
      if (m.page) bubble(meta, 'span', 'fb-admin-row-page', m.page);
      bubble(body, 'p', 'fb-admin-row-text', m.content);

      var del = bubble(row, 'button', 'btn-mini is-danger fb-admin-row-del', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { removeIds([m.id]); });
      box.appendChild(row);
    });
  }

  function renderPickBar(items) {
    var n = items ? items.filter(function (m) { return picked[m.id]; }).length
      : Object.keys(picked).length;
    var count = $('fb-admin-pick-count');
    if (count) count.textContent = '已选 ' + n + ' 条';
    var btn = $('fb-admin-del-checked');
    if (btn) {
      btn.disabled = n === 0;
      btn.textContent = '删除勾选' + (n ? '（' + n + '）' : '');
    }
  }

  function refresh(quiet) {
    return readAll().then(function (items) {
      all = items;
      // 已被删掉的 id 不该继续留在勾选集里
      Object.keys(picked).forEach(function (id) {
        if (!items.some(function (m) { return m.id === id; })) delete picked[id];
      });
      render();
      if (!quiet) setMsg('已刷新，共 ' + all.length + ' 条', 'ok');
      return all;
    }).catch(function (e) {
      setMsg('读取失败：' + e.message, 'error');
      return null;
    });
  }

  function removeIds(ids) {
    if (!ids.length) return;
    var n = ids.length;
    var ok = window.confirm(
      '确定删除选中的 ' + n + ' 条留言？\n\n' +
      '• 删除会立刻提交到仓库，公开列表约 1 分钟后不再显示；\n' +
      '• 操作不可在面板里撤销（Git 提交历史仍可追溯）；\n' +
      '• 期间若有新留言提交，可能需要刷新后重试。'
    );
    if (!ok) return;

    setMsg('正在删除…', '');
    var rest = all.filter(function (m) { return ids.indexOf(m.id) < 0; });
    writeAll(rest, 'chore: 删除 ' + n + ' 条留言 (LBJP feedback)')
      .then(function () {
        ids.forEach(function (id) { delete picked[id]; });
        return refresh(true);
      })
      .then(function (res) {
        if (res) setMsg('已删除 ' + n + ' 条留言', 'ok');
      })
      .catch(function (e) {
        setMsg('删除失败：' + e.message, 'error');
      });
  }

  function setView(on) {
    viewOn = !!on;
    var layout = document.querySelector('.admin-layout');
    var view = $('fb-admin-view');
    var btn = $('fb-manage-btn');
    if (!view || !layout) return;
    view.classList.toggle('is-hidden', !viewOn);
    layout.classList.toggle('is-hidden', viewOn);
    if (btn) btn.classList.toggle('is-active', viewOn);
    if (viewOn) refresh(false);
  }

  function boot() {
    var btn = $('fb-manage-btn');
    if (!btn) return;
    btn.addEventListener('click', function () { setView(!viewOn); });
    var back = $('fb-admin-back');
    if (back) back.addEventListener('click', function () { setView(false); });
    var refreshBtn = $('fb-admin-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { refresh(false); });

    ['fb-admin-search', 'fb-admin-type', 'fb-admin-sort'].forEach(function (id) {
      var n = $(id);
      if (n) n.addEventListener(n.tagName === 'INPUT' ? 'input' : 'change', render);
    });

    $('fb-admin-pick-all').addEventListener('click', function () {
      visible().forEach(function (m) { picked[m.id] = true; });
      render();
    });
    $('fb-admin-pick-invert').addEventListener('click', function () {
      visible().forEach(function (m) { if (picked[m.id]) delete picked[m.id]; else picked[m.id] = true; });
      render();
    });
    $('fb-admin-pick-none').addEventListener('click', function () { picked = {}; render(); });
    $('fb-admin-del-checked').addEventListener('click', function () {
      var ids = Object.keys(picked);
      removeIds(ids);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
