/* 留言板 · 游客端（自管模块，不依赖 / 不修改 app.js）
 * ------------------------------------------------------------------
 * 数据真源：data/messages.json（仓库文件，公开只读）
 * 写入通道：feedback-config.js 的 endpoint（Cloudflare Worker）
 *          本地开发自动改投 /api/feedback（server/server.js 模拟代理）
 * 安全约定：
 *   - 本文件及游客页里绝不含任何令牌；匿名写入由 Worker 持 PAT 代劳。
 *   - 所有用户内容一律 textContent 渲染，不拼 innerHTML。
 *   - 不收集邮箱/手机号等联系方式：数据文件是公开的，存了就等于公开。
 */
(function () {
  'use strict';

  var CFG = window.LBJP_FEEDBACK_CONFIG || {};
  var DATA_PATH = CFG.dataPath || 'data/messages.json';
  var MAX_LEN = Number(CFG.maxLen) || 500;
  var MIN_LEN = Number(CFG.minLen) || 4;
  var COOLDOWN = Number(CFG.cooldownMs) || 30000;
  var LAST_KEY = 'lbjp_fb_last';
  var TYPES = ['建议', '问题', '夸奖', '其他'];

  var $ = function (id) { return document.getElementById(id); };
  var list = [];        // 已落库的留言（最新在前）
  var pending = null;   // 刚提交、Pages 尚未重建时的乐观占位
  var pollTimer = null;

  function endpoint() {
    if (CFG.endpoint) return String(CFG.endpoint).replace(/\/+$/, '');
    var host = String(window.location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return 'api/feedback';
    return '';
  }

  function setMsg(text, kind) {
    var n = $('fb-msg');
    if (!n) return;
    n.textContent = text || '';
    n.className = 'fb-msg' + (kind ? ' is-' + kind : '');
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  function safe(obj, key, max) {
    return String(obj && obj[key] != null ? obj[key] : '').slice(0, max);
  }

  function normalize(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (m) {
      return m && typeof m === 'object' && String(m.id || '').length > 0 &&
        String(m.content || '').trim().length > 0;
    }).map(function (m) {
      return {
        id: safe(m, 'id', 80),
        nickname: safe(m, 'nickname', 20) || '匿名',
        type: TYPES.indexOf(m.type) >= 0 ? m.type : '其他',
        content: safe(m, 'content', MAX_LEN + 50),
        page: safe(m, 'page', 120),
        createdAt: safe(m, 'createdAt', 40)
      };
    }).sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  function bubble(el, tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    el.appendChild(n);
    return n;
  }

  function buildCard(m, isPending) {
    var card = document.createElement('article');
    card.className = 'fb-card' + (isPending ? ' is-pending' : '');
    card.setAttribute('data-id', m.id);

    var head = bubble(card, 'div', 'fb-card-head');
    var who = bubble(head, 'div', 'fb-card-who');
    bubble(who, 'span', 'fb-avatar', m.nickname.slice(0, 1).toUpperCase());
    bubble(who, 'strong', 'fb-nick', m.nickname);
    var badge = bubble(head, 'span', 'fb-badge', m.type);
    badge.setAttribute('data-type', m.type);
    badge.setAttribute('aria-label', '留言类型：' + m.type);

    bubble(card, 'p', 'fb-card-text', m.content);

    var foot = bubble(card, 'div', 'fb-card-foot');
    bubble(foot, 'time', 'fb-time', fmtTime(m.createdAt));
    if (m.page) bubble(foot, 'span', 'fb-page', '来自 ' + m.page);
    if (isPending) bubble(foot, 'span', 'fb-sync', '刚刚提交 · 站点同步中');
    return card;
  }

  function render() {
    var box = $('fb-list');
    var counter = $('fb-count');
    if (!box) return;
    var items = list.slice();
    if (pending) {
      // Pages 已经重建出这条时，撤掉占位，避免重复显示
      if (items.some(function (m) { return m.id === pending.id; })) pending = null;
      else items.unshift(pending);
    }
    box.textContent = '';
    if (counter) counter.textContent = list.length ? ('共 ' + list.length + ' 条留言') : '暂无留言';
    if (!items.length) {
      bubble(box, 'p', 'fb-empty', '还没有人留言，来当第一个吧。');
      return;
    }
    items.forEach(function (m) { box.appendChild(buildCard(m, !!(pending && m.id === pending.id))); });
  }

  function loadMessages(quiet) {
    var url = DATA_PATH + (DATA_PATH.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) return [];          // 首次部署 / 文件还没建：空态，不是错误
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (raw) {
      list = normalize(raw);
      render();
      return list;
    }).catch(function (e) {
      if (!quiet) setMsg('留言暂时读不出来：' + e.message, 'error');
      render();
      return list;
    });
  }

  // Pages 重建有延迟：提交成功后轻量轮询，拿到真数据就撤掉乐观占位。
  function pollFor(id, attempt) {
    if (pollTimer) clearTimeout(pollTimer);
    if (!pending || attempt >= 6) return;       // 最多约 48 秒
    pollTimer = setTimeout(function () {
      loadMessages(true).then(function (items) {
        if (items.some(function (m) { return m.id === id; })) {
          pending = null;
          render();
          setMsg('留言已发布，感谢反馈！', 'ok');
        } else {
          pollFor(id, attempt + 1);
        }
      });
    }, CFG.endpoint ? 8000 : 1500);   // 线上等 Pages 重建；本地后端写完即可见
  }

  function clientCooldown() {
    try {
      var last = Number(sessionStorage.getItem(LAST_KEY) || 0);
      return Math.max(0, COOLDOWN - (Date.now() - last));
    } catch (e) { return 0; }
  }

  function rememberSubmit() {
    try { sessionStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) { /* 隐私模式 */ }
  }

  function makeId() {
    return 'm-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  function submit(ev) {
    ev.preventDefault();
    var form = $('fb-form');
    var btn = $('fb-submit');
    if (!form || !btn) return;

    // 蜜罐：真人看不见也填不到；机器人填了就直接吞掉（不报错、不落库）
    if ($('fb-hp') && String($('fb-hp').value || '').trim()) {
      setMsg('留言已提交，感谢反馈！', 'ok');
      form.reset();
      return;
    }

    var nickname = String($('fb-nickname').value || '').trim().slice(0, 20);
    var type = String($('fb-type').value || '其他');
    var content = String($('fb-content').value || '').trim();
    var ep = endpoint();

    if (content.length < MIN_LEN) { setMsg('留言至少 ' + MIN_LEN + ' 个字', 'error'); return; }
    if (content.length > MAX_LEN) { setMsg('留言最多 ' + MAX_LEN + ' 字，当前 ' + content.length + ' 字', 'error'); return; }
    if (TYPES.indexOf(type) < 0) { type = '其他'; }
    var wait = clientCooldown();
    if (wait > 0) { setMsg('提交太频繁了，请 ' + Math.ceil(wait / 1000) + ' 秒后再试', 'error'); return; }
    if (!ep) {
      setMsg('留言提交通道还没开通（管理员需部署写入代理），现有留言仍可查看。', 'error');
      return;
    }

    var payload = {
      nickname: nickname || '匿名',
      type: type,
      content: content,
      page: window.location.pathname + window.location.search,
      _hp: ''
    };

    btn.disabled = true;
    btn.textContent = '提交中…';
    setMsg('正在提交…', '');

    fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    }).then(function (j) {
      var saved = (j && j.message) || null;
      var optimistic = saved && saved.id ? normalize([saved])[0] : {
        id: makeId(), nickname: payload.nickname, type: payload.type,
        content: payload.content, page: payload.page,
        createdAt: new Date().toISOString()
      };
      pending = optimistic;
      rememberSubmit();
      form.reset();
      updateCount();
      render();
      setMsg('已提交，感谢反馈！站点约 1 分钟内同步到列表。', 'ok');
      if (saved && saved.id) pollFor(saved.id, 0);
    }).catch(function (e) {
      setMsg('提交失败：' + e.message + '（可稍后重试）', 'error');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '发布留言';
    });
  }

  // 站点顶栏 + 控制条都是 sticky，且控制条一直吸顶到文档末尾。
  // 锚点跳转若只按默认位置对齐，留言板标题会被整条控制条压住 → 实测两处 sticky 高度再补偿。
  function stickyOffset() {
    var hdr = document.querySelector('.site-header');
    var bar = document.getElementById('control-bar');
    return (hdr ? hdr.getBoundingClientRect().height : 0) +
      (bar ? bar.getBoundingClientRect().height : 0) + 16;
  }

  function scrollToFeedback(doFocus) {
    var sec = $('feedback');
    if (!sec) return;
    var y = sec.getBoundingClientRect().top + (window.pageYOffset || 0) - stickyOffset();
    // 从图库顶部跳过来可能近万像素：长距离用瞬时定位（原生 smooth 会拖很久且常被中断），
    // 短距离仍保留平滑过渡。
    var dist = Math.abs(y - (window.pageYOffset || 0));
    window.scrollTo({ top: Math.max(0, y), behavior: dist > 2000 ? 'auto' : 'smooth' });
    if (window.__LBJP_SYNC_FAB__) window.__LBJP_SYNC_FAB__();
    if (doFocus) setTimeout(function () {
      var c = $('fb-content');
      if (c) c.focus({ preventScroll: true });
    }, 550);
  }

  function updateCount() {
    var n = $('fb-content');
    var c = $('fb-count-chars');
    if (n && c) c.textContent = String(n.value.length) + ' / ' + MAX_LEN;
  }

  function boot() {
    var form = $('fb-form');
    if (!form) return;
    form.addEventListener('submit', submit);
    var content = $('fb-content');
    if (content) {
      content.addEventListener('input', updateCount);
      content.setAttribute('maxlength', String(MAX_LEN));
    }
    var refresh = $('fb-refresh');
    if (refresh) refresh.addEventListener('click', function () {
      loadMessages(false).then(function () { setMsg('已刷新', 'ok'); });
    });
    var fab = $('fb-fab');
    if (fab) fab.addEventListener('click', function () { scrollToFeedback(true); });
    // 顶栏锚点也走同一套 sticky 补偿：纯 #hash 跳转只避开 header，仍会被控制条压住标题
    Array.prototype.forEach.call(document.querySelectorAll('a[href="#feedback"]'), function (a) {
      a.addEventListener('click', function (ev) { ev.preventDefault(); scrollToFeedback(false); });
    });
    // 已经身在留言板时收起悬浮入口，避免小屏上压住留言卡片。
    // 用 scroll 监听而非 IntersectionObserver：长距离瞬时跳转后 IO 的首帧通知存在时序竞争，
    // 滚动事件 + 几何判定在两种跳转方式下都确定生效。
    if (fab) {
      var syncFab = function () {
        var sec = $('feedback');
        if (!sec) return;
        var r = sec.getBoundingClientRect();
        fab.classList.toggle('is-hidden', r.top < window.innerHeight * 0.6 && r.bottom > 0);
      };
      window.addEventListener('scroll', syncFab, { passive: true });
      window.addEventListener('resize', syncFab);
      // 锚点点击后立刻同步一次（不等下一帧滚动事件）
      window.addEventListener('hashchange', syncFab);
      syncFab();
      window.__LBJP_SYNC_FAB__ = syncFab;   // 跳转后由 scrollToFeedback 主动调用
    }
    if (!endpoint()) {
      var hint = $('fb-endpoint-hint');
      if (hint) hint.classList.remove('is-hidden');
    }
    updateCount();
    loadMessages(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
