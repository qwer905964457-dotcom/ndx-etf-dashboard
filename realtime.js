(() => {
  const REALTIME_URL = './realtime.json';
  const ALERT_KEY = 'ndx-realtime-premium-alert-v4';
  const ENABLE_KEY = 'ndx-realtime-premium-notification-enabled-v1';
  const PRIMARY_KEY = 'ndx-primary-etf-code';
  const DEFAULT_PRIMARY = '513390';
  const LOW_THRESHOLDS = [3, 5];
  const REFRESH_OPEN = 60 * 1000;
  const REFRESH_CLOSED = 5 * 60 * 1000;

  let activeFilter = 'all';
  let lastPayload = null;

  const ok = value => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text || ['-', '--', '暂无数据', 'null', 'none', 'nan', 'n/a'].includes(text.toLowerCase())) return false;
    return Number.isFinite(Number(text));
  };
  const num = value => ok(value) ? Number(value) : null;
  const fmt = (value, digits = 2) => ok(value) ? Number(value).toFixed(digits).replace(/\.00$/, '') : '暂无数据';
  const fmtPct = value => ok(value) ? `${fmt(value)}%` : '暂无数据';
  const el = id => document.getElementById(id);

  function parseCnTime(value) {
    if (!value || value === '尚未运行') return null;
    const match = String(value).match(/(20\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const [, y, m, d, hh, mm, ss = '0'] = match;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  function minutesSince(value) {
    const dt = parseCnTime(value);
    if (!dt) return null;
    return Math.max(0, (Date.now() - dt.getTime()) / 60000);
  }

  function normalizeRows(payload) {
    return (Array.isArray(payload?.funds) ? payload.funds : []).map(row => ({
      ...row,
      price: num(row.price),
      iopv: num(row.iopv),
      premium: num(row.premium),
      sourceTime: row.data_time,
      sourceLabel: row.source_label || row.source,
      freshLabel: row.fresh_label,
      change: num(row.change_pct),
      canAlert: row.can_alert === true && ok(row.premium),
    }));
  }

  function primaryCode() {
    return localStorage.getItem(PRIMARY_KEY) || window.NDXDashboard?.getPrimaryCode?.() || DEFAULT_PRIMARY;
  }

  function loadAlertState() {
    try { return JSON.parse(localStorage.getItem(ALERT_KEY)) || {lastPremium: {}, armed: {}}; }
    catch { return {lastPremium: {}, armed: {}}; }
  }

  function saveAlertState(state) {
    localStorage.setItem(ALERT_KEY, JSON.stringify(state));
  }

  function ensureStyles() {
    if (document.getElementById('realtimePremiumStyles')) return;
    const style = document.createElement('style');
    style.id = 'realtimePremiumStyles';
    style.textContent = `
      .realtime-card{border-color:#2f8a62;background:linear-gradient(135deg,#f8fffb,#eefaf4)}
      .realtime-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
      .realtime-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.realtime-actions button,.realtime-filter button{border:2px solid var(--ink);border-radius:12px;background:#dcf5e8;padding:9px 12px;font-weight:900;color:var(--ink)}
      .realtime-filter{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.realtime-filter button.active{background:#dbeeff}
      .realtime-status{color:var(--muted);line-height:1.65;margin:8px 0 0}.realtime-table{display:grid;gap:8px;margin-top:12px}
      .data-health{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:center;margin-top:10px;padding:12px;border-radius:14px;border:1.5px dashed #9eb8cb;background:#fff}.health-dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--ink)}.health-green{background:#7bd99b}.health-yellow{background:#ffe08a}.health-red{background:#ff9caf}
      .realtime-row{display:grid;grid-template-columns:1.05fr .85fr .7fr .7fr 1.35fr;gap:8px;align-items:center;padding:10px;border-radius:12px;background:#fff;border:1px solid #d8eadf}
      .realtime-row.header{background:#e8f6ef;font-weight:950}.realtime-row b{font-size:18px}.premium-low{color:#2f8a62}.premium-mid{color:#a06b00}.premium-high{color:#bd4c62}.tiny{font-size:12px;color:var(--muted);line-height:1.45}.fresh-ok{color:#2f8a62}.fresh-warn{color:#a06b00}.fresh-bad{color:#bd4c62}
      .visual-alert{margin-top:12px;padding:12px;border-radius:14px;border:2px solid #2f8a62;background:#effbf4;line-height:1.7;font-weight:850}.visual-alert.empty{border-color:#d7e2ec;background:#fff;color:var(--muted);font-weight:700}
      @media(max-width:760px){.realtime-row{grid-template-columns:1fr 1fr}.realtime-row.header{display:none}.realtime-row span::before{display:block;font-size:11px;color:var(--muted);font-weight:700}.realtime-row span:nth-child(2)::before{content:'溢价口径'}.realtime-row span:nth-child(3)::before{content:'最新价'}.realtime-row span:nth-child(4)::before{content:'日涨跌'}.realtime-row span:nth-child(5)::before{content:'可靠性'}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    ensureStyles();
    let panel = el('realtimePremiumPanel');
    if (panel) return panel;
    panel = document.createElement('article');
    panel.id = 'realtimePremiumPanel';
    panel.className = 'card realtime-card';
    panel.innerHTML = `
      <div class="realtime-head">
        <div>
          <div class="section-label">场内额外仓监控</div>
          <h2>低溢价主动提醒</h2>
          <p class="realtime-status" id="realtimeStatus">准备读取 realtime.json…</p>
        </div>
        <div class="realtime-actions">
          <button id="realtimeRefreshBtn">立即刷新</button>
          <button id="enablePremiumNotifyBtn">开启提醒</button>
        </div>
      </div>
      <div class="data-health" id="dataHealthBox"><i class="health-dot health-red"></i><div><b>数据状态：等待读取</b><div class="tiny">字段拿不到就显示暂无数据，不用旧值冒充实时。</div></div></div>
      <div id="realtimeVisualAlert" class="visual-alert empty">低于5%会提示“观察区”，低于3%会提示“底仓区”。提醒只用于场内额外买入，不影响场外每日300元。</div>
      <div class="realtime-filter">
        <button class="active" data-rt-filter="all">全部</button>
        <button data-rt-filter="alertable">可提醒</button>
        <button data-rt-filter="low">≤5%</button>
        <button data-rt-filter="high">≥9%</button>
        <button data-rt-filter="missing">暂无数据</button>
      </div>
      <div class="realtime-table" id="realtimePremiumTable"></div>
      <p class="tiny">说明：页面只读取本仓库生成的 realtime.json，不再让浏览器跨域抓外站。realtime.json 由 GitHub Actions 在A股交易时段附近约5分钟更新一次；GitHub调度可能延迟。下单前仍以券商APP实时IOPV/溢价为最终核对。</p>
    `;
    const home = el('home');
    const warning = document.querySelector('#home .warning-card');
    if (home && warning) home.insertBefore(panel, warning);
    else document.querySelector('.page')?.insertBefore(panel, el('loadStatus')?.nextSibling || null);

    el('realtimeRefreshBtn')?.addEventListener('click', () => refreshRealtime(true));
    el('enablePremiumNotifyBtn')?.addEventListener('click', enableNotifications);
    panel.addEventListener('click', event => {
      const btn = event.target.closest('[data-rt-filter]');
      if (!btn) return;
      activeFilter = btn.dataset.rtFilter;
      panel.querySelectorAll('[data-rt-filter]').forEach(x => x.classList.toggle('active', x === btn));
      if (lastPayload) renderRealtime(lastPayload, false);
    });
    updateNotifyButton();
    return panel;
  }

  function updateNotifyButton() {
    const btn = el('enablePremiumNotifyBtn');
    if (!btn) return;
    const enabled = localStorage.getItem(ENABLE_KEY) === '1';
    btn.textContent = enabled ? '提醒已开启' : '开启提醒';
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      alert('当前浏览器不支持系统通知，页面内仍会显示低溢价提醒。');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      localStorage.setItem(ENABLE_KEY, '1');
      updateNotifyButton();
      new Notification('纳指ETF低溢价提醒已开启', {body: '页面打开时，realtime.json 首次进入5%/3%会提醒；同一状态不会重复轰炸。'});
    } else {
      localStorage.setItem(ENABLE_KEY, '0');
      updateNotifyButton();
    }
  }

  function stateLabel(premium) {
    if (!ok(premium)) return ['暂无数据', 'fresh-bad'];
    if (premium <= 3) return ['底仓区', 'premium-low'];
    if (premium <= 5) return ['观察区', 'premium-low'];
    if (premium <= 7) return ['可小口', 'premium-mid'];
    if (premium <= 9) return ['偏高', 'premium-high'];
    return ['高溢价', 'premium-high'];
  }

  function freshnessClass(freshness) {
    if (freshness === 'realtime') return 'fresh-ok';
    if (freshness === 'delayed' || freshness === 'today') return 'fresh-warn';
    return 'fresh-bad';
  }

  function health(payload) {
    const age = minutesSince(payload?.generated_at);
    const valid = Number(payload?.summary?.valid_count || 0);
    const session = payload?.market_status?.is_trading_session === true;
    if (age !== null && session && age <= 8 && valid > 0) return ['green', `绿色：${fmt(age, 1)}分钟前更新，交易时段数据可参考`];
    if (age !== null && age <= 60 && valid > 0) return ['yellow', `黄色：${fmt(age, 1)}分钟前更新，只作参考，不把旧数据当实时`];
    return ['red', age === null ? '红色：realtime.json尚未生成有效时间' : `红色：${fmt(age, 1)}分钟前更新，数据陈旧或无可靠数据`];
  }

  function tradingText(payload) {
    const m = payload?.market_status || {};
    if (m.is_trading_session) return `A股交易中｜${m.reason || '交易日'}｜${m.calendar_source || '交易日历'}`;
    if (m.is_trading_day === false) return `A股休市｜${m.reason || '休市'}｜${m.calendar_source || '交易日历'}`;
    return `非连续竞价时段｜${m.reason || '等待交易'}｜${m.calendar_source || '交易日历'}`;
  }

  function pass(row) {
    const premium = num(row.premium);
    if (activeFilter === 'alertable') return row.canAlert === true;
    if (activeFilter === 'low') return ok(premium) && premium <= 5;
    if (activeFilter === 'high') return ok(premium) && premium >= 9;
    if (activeFilter === 'missing') return !ok(premium);
    return true;
  }

  function renderRealtime(payload, forced) {
    lastPayload = payload;
    ensurePanel();
    const rows = normalizeRows(payload);
    if (window.NDXDashboard?.setRealtimeRows) window.NDXDashboard.setRealtimeRows(rows);

    const status = el('realtimeStatus');
    const valid = rows.filter(row => ok(row.premium));
    const alertable = rows.filter(row => row.canAlert).length;
    if (status) status.textContent = `${forced ? '手动刷新' : '自动读取'}：${payload?.updated_at || '暂无时间'}｜${tradingText(payload)}｜成功 ${valid.length}/12，可提醒 ${alertable}/12，错误 ${(payload?.errors || []).length}`;

    const [healthColor, healthText] = health(payload);
    const hb = el('dataHealthBox');
    if (hb) hb.innerHTML = `<i class="health-dot health-${healthColor}"></i><div><b>数据状态：${healthText}</b><div class="tiny">来源：${payload?.source_note || '暂无说明'}</div></div>`;

    const sorted = [...rows].filter(pass).sort((a, b) => (num(a.premium) ?? 999) - (num(b.premium) ?? 999));
    const cells = sorted.map(row => {
      const [label, cls] = stateLabel(row.premium);
      const freshCls = freshnessClass(row.freshness);
      return `<div class="realtime-row">
        <span><strong>${row.code} ${row.company}</strong><div class="tiny">${row.name || '纳指100ETF'}</div></span>
        <span><b class="${cls}">${fmtPct(row.premium)}</b><div class="tiny">${label}｜${row.sourceLabel || row.source || '暂无来源'}</div></span>
        <span>${ok(row.price) ? fmt(row.price, 3) : '暂无数据'}${ok(row.iopv) ? `<div class="tiny">IOPV ${fmt(row.iopv, 4)}</div>` : '<div class="tiny">IOPV 暂无数据</div>'}</span>
        <span class="${ok(row.change) && num(row.change) < 0 ? 'premium-high' : 'premium-low'}">${ok(row.change) ? fmtPct(row.change) : '暂无数据'}</span>
        <span><b class="tiny ${freshCls}">${row.freshLabel || '未校验'}</b><div class="tiny">${row.sourceTime || '未知时间'}</div></span>
      </div>`;
    }).join('');
    const table = el('realtimePremiumTable');
    if (table) table.innerHTML = `<div class="realtime-row header"><span>ETF</span><span>溢价口径</span><span>最新价</span><span>日涨跌</span><span>可靠性</span></div>${cells || '<div class="empty">当前筛选下无数据。</div>'}`;

    updatePrimaryDisplay(rows);
  }

  function updatePrimaryDisplay(rows) {
    const primary = primaryCode();
    const row = rows.find(item => String(item.code) === String(primary));
    const source = el('sourceNote');
    if (source) source.textContent = '日频data.json + 盘中realtime.json';
    const updated = el('updatedAt');
    if (updated && lastPayload?.updated_at) updated.textContent = lastPayload.updated_at;
    const displayable = row && ok(row.premium) && ['realtime', 'delayed', 'today'].includes(row.freshness);
    if (!displayable) {
      const note = el('premiumCardNote');
      if (note) note.textContent = `${primary} 盘中溢价暂无可靠数据，保留它自己的日频溢价，不用其他ETF替代。`;
      return;
    }
    const text = `${fmtPct(row.premium)}（${row.sourceLabel || '盘中'}）`;
    ['heroPremium', 'holdingPremium', 'myPremium', 'premiumCardValue'].forEach(id => {
      const node = el(id);
      if (node) node.textContent = text;
    });
    const note = el('premiumCardNote');
    const [label] = stateLabel(row.premium);
    if (note) note.textContent = `${label}｜${row.freshLabel || '未校验'}｜${row.sourceTime || '未知时间'}`;
  }

  function notifyLowPremium(payload) {
    const rows = normalizeRows(payload);
    const primary = primaryCode();
    const row = rows.find(item => String(item.code) === String(primary));
    const state = loadAlertState();
    state.lastPremium ||= {};
    state.armed ||= {};
    const messages = [];

    [row].filter(item => item && ok(item.premium)).forEach(row => {
      const previous = state.lastPremium[row.code];
      const target = row.premium <= 3 ? 3 : row.premium <= 5 ? 5 : null;
      if (target && row.canAlert) {
        const key = `${row.code}-${target}`;
        const crossed = !ok(previous) || Number(previous) > target;
        if (crossed && state.armed[key] !== true) {
          const label = target === 3 ? '底仓区' : '观察区';
          messages.push(`${label}：${row.code} ${row.company} 溢价 ${fmtPct(row.premium)}，${row.freshLabel || ''}，来源 ${row.sourceLabel || row.source}`);
          state.armed[key] = true;
          if (target === 3) state.armed[`${row.code}-5`] = true;
        }
      }
      LOW_THRESHOLDS.forEach(threshold => {
        if (row.premium > threshold) state.armed[`${row.code}-${threshold}`] = false;
      });
      state.lastPremium[row.code] = row.premium;
    });
    saveAlertState(state);

    const visual = el('realtimeVisualAlert');
    if (visual) {
      if (messages.length) {
        visual.classList.remove('empty');
        visual.innerHTML = messages.map(x => `<div>🔔 ${x}</div>`).join('');
      } else {
        visual.classList.add('empty');
        visual.textContent = !row || !ok(row.premium)
          ? `${primary} 溢价暂无数据，不使用其他ETF替代，也不触发提醒。`
          : payload?.market_status?.is_trading_session
          ? `暂未触发 ${primary} 低溢价提醒。只有它自己的实时溢价数据新鲜、首次进入5%/3%才提醒。`
          : `${tradingText(payload)}。显示数据但不触发盘中低溢价提醒。`;
      }
    }

    const enabled = localStorage.getItem(ENABLE_KEY) === '1';
    if (enabled && 'Notification' in window && Notification.permission === 'granted') {
      messages.forEach(message => new Notification('纳指ETF低溢价提醒', {body: message}));
    }
  }

  async function loadRealtimeJson() {
    const res = await fetch(`${REALTIME_URL}?v=${Date.now()}`, {cache: 'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function refreshRealtime(forced = false) {
    ensurePanel();
    const table = el('realtimePremiumTable');
    if (table) table.innerHTML = '<div class="empty">正在读取 realtime.json…</div>';
    try {
      const payload = await loadRealtimeJson();
      renderRealtime(payload, forced);
      notifyLowPremium(payload);
      return payload;
    } catch (error) {
      const status = el('realtimeStatus');
      if (status) status.textContent = `realtime.json读取失败：${error.message}`;
      const hb = el('dataHealthBox');
      if (hb) hb.innerHTML = `<i class="health-dot health-red"></i><div><b>数据状态：红色，realtime.json读取失败</b><div class="tiny">${error.message}</div></div>`;
      return null;
    }
  }

  function nextInterval(payload) {
    return payload?.market_status?.is_trading_session ? REFRESH_OPEN : REFRESH_CLOSED;
  }

  function loop() {
    refreshRealtime(false).then(payload => setTimeout(loop, nextInterval(payload)));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loop);
  else loop();
})();
