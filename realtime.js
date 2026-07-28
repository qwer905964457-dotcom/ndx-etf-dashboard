(() => {
  const ETF_LIST = [
    ['159941', '广发'], ['159632', '华安'], ['513100', '国泰'], ['513300', '华夏'],
    ['513390', '博时'], ['513870', '富国'], ['159659', '招商'], ['513110', '华泰柏瑞'],
    ['159513', '大成'], ['159501', '嘉实'], ['159660', '汇添富'], ['159696', '易方达']
  ].map(([code, company]) => ({code, company, name: `${company}纳指100ETF`}));

  const ALERT_KEY = 'ndx-realtime-premium-alert-v2';
  const ENABLE_KEY = 'ndx-realtime-premium-notification-enabled-v1';
  const PRIMARY_KEY = 'ndx-primary-etf-code';
  const DEFAULT_PRIMARY = '513390';
  const REFRESH_OPEN = 60 * 1000;
  const REFRESH_CLOSED = 5 * 60 * 1000;
  const LOW_THRESHOLDS = [3, 5];
  const FRESH_LIMIT_MS = 3.5 * 60 * 1000;
  const DELAY_LIMIT_MS = 15 * 60 * 1000;
  const CORS_PROXIES = [
    url => url,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`
  ];

  const ok = value => Number.isFinite(Number(value));
  const num = value => ok(value) ? Number(value) : null;
  const fmt = (value, digits = 2) => ok(value) ? Number(value).toFixed(digits).replace(/\.00$/, '') : '暂无';
  const fmtPct = value => ok(value) ? `${fmt(value)}%` : '暂无';
  const pad = value => String(value).padStart(2, '0');

  function cnParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}:${parts.second}`,
      hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: parts.weekday
    };
  }

  function isTradingSession() {
    const p = cnParts();
    if (p.weekday.includes('六') || p.weekday.includes('日')) return false;
    const m = p.hour * 60 + p.minute;
    return (m >= 9 * 60 + 30 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60);
  }

  function secid(code) {
    return `${String(code).startsWith('5') ? '1' : '0'}.${code}`;
  }

  function loadAlertState() {
    try { return JSON.parse(localStorage.getItem(ALERT_KEY)) || {lastPremium: {}, armed: {}}; }
    catch { return {lastPremium: {}, armed: {}}; }
  }

  function saveAlertState(state) {
    localStorage.setItem(ALERT_KEY, JSON.stringify(state));
  }

  function timeoutFetch(url, options = {}, ms = 9000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, {...options, signal: controller.signal}).finally(() => clearTimeout(timer));
  }

  function parsePercent(text) {
    const match = String(text || '').replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*%/);
    return match ? Number(match[1]) : null;
  }

  function normalizeDate(text) {
    const value = String(text || '').trim();
    const full = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:\s+(\d{1,2}:\d{1,2}(?::\d{1,2})?))?/);
    if (!full) return null;
    return `${full[1]}-${pad(full[2])}-${pad(full[3])}${full[4] ? ` ${full[4].length === 5 ? `${full[4]}:00` : full[4]}` : ''}`;
  }

  function parseCnDateTime(value) {
    const normalized = normalizeDate(value);
    if (!normalized) return null;
    const [date, time] = normalized.split(' ');
    if (!time) return {date, timestamp: null, hasMinute: false};
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm, ss = 0] = time.split(':').map(Number);
    return {date, timestamp: new Date(y, m - 1, d, hh, mm, ss).getTime(), hasMinute: true};
  }

  function classifyFreshness(sourceTime) {
    const trading = isTradingSession();
    const now = cnParts();
    const parsed = parseCnDateTime(sourceTime);
    if (!parsed) return {freshness: 'unknown', canAlert: false, label: '无时间戳，不提醒'};
    if (parsed.date !== now.date) return {freshness: 'stale', canAlert: false, label: '非今日数据，不提醒'};
    if (!parsed.hasMinute) return {freshness: 'today', canAlert: false, label: '今日无分钟级时间，只展示'};
    const age = Date.now() - parsed.timestamp;
    if (age <= FRESH_LIMIT_MS) return {freshness: 'realtime', canAlert: trading, label: trading ? '分钟级实时，可提醒' : '非交易时段，只展示'};
    if (age <= DELAY_LIMIT_MS) return {freshness: 'delayed', canAlert: false, label: '延迟数据，只展示'};
    return {freshness: 'stale', canAlert: false, label: '时间过旧，不提醒'};
  }

  function parseHaoEtf(code, html) {
    const pageText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const textOnly = pageText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const timeMatch = textOnly.match(/数据更新时间[：:\s]*(20\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)/);
    const sourceTime = timeMatch ? timeMatch[1] : cnParts().date;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('tr')];
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td,th')].map(cell => cell.textContent.trim());
      if (!cells.length || cells[0] !== code) continue;
      const candidates = [];
      if (cells[3] !== undefined) {
        const value = parsePercent(cells[3]);
        if (ok(value) && Math.abs(value) < 60) candidates.push({publishedPremium: value, sourceTime});
      }
      if (cells[5] !== undefined) {
        const value = parsePercent(cells[5]);
        const cellTime = normalizeDate(cells[6]) || sourceTime;
        if (ok(value) && Math.abs(value) < 60) candidates.push({publishedPremium: value, sourceTime: cellTime});
      }
      if (candidates.length) return candidates[0];
    }

    const loose = textOnly.match(new RegExp(`${code}[\\s\\S]{0,120}?(-?\\d+(?:\\.\\d+)?)\\s*%`));
    if (loose) return {publishedPremium: Number(loose[1]), sourceTime};
    throw new Error('未解析到溢价');
  }

  async function fetchHaoPremium(code) {
    const url = `https://www.haoetf.com/qdii/${code}`;
    let lastError = null;
    for (const wrap of CORS_PROXIES) {
      try {
        const res = await timeoutFetch(wrap(url), {cache: 'no-store'}, 9000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const parsed = parseHaoEtf(code, html);
        return {...parsed, source: wrap(url) === url ? 'HaoETF直连' : 'HaoETF公开页', sourceUrl: url};
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('HaoETF获取失败');
  }

  async function fetchEastmoneyQuotes() {
    const fields = 'f12,f14,f2,f3,f4,f18,f15,f16,f17,f124,f152';
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${ETF_LIST.map(x => secid(x.code)).join(',')}`;
    const res = await timeoutFetch(url, {cache: 'no-store'}, 9000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const rows = payload?.data?.diff || [];
    const map = new Map();
    rows.forEach(row => {
      const price = num(row.f2);
      const change = num(row.f3);
      const prevClose = num(row.f18);
      const quoteTime = ok(row.f124) ? cnParts(new Date(Number(row.f124) * 1000)).date + ' ' + cnParts(new Date(Number(row.f124) * 1000)).time : null;
      if (row.f12) map.set(String(row.f12), {price, change, prevClose, quoteName: row.f14, quoteTime});
    });
    return map;
  }

  function mergePremium(item, published, quote) {
    const price = num(quote.price);
    const iopv = num(quote.iopv);
    if (ok(price) && ok(iopv) && iopv > 0) {
      const premium = (price / iopv - 1) * 100;
      const sourceTime = quote.quoteTime || published.sourceTime;
      return {
        ...item, ...quote,
        premium, iopv, sourceTime,
        source: '实时价÷IOPV计算',
        sourceLabel: '实时价÷IOPV',
        quality: 'calculated-iopv'
      };
    }
    return {
      ...item, ...quote,
      premium: published.publishedPremium,
      publishedPremium: published.publishedPremium,
      sourceTime: published.sourceTime,
      source: published.source,
      sourceLabel: '公开页面溢价',
      quality: 'public-page'
    };
  }

  function ensureStyles() {
    if (document.getElementById('realtimePremiumStyles')) return;
    const style = document.createElement('style');
    style.id = 'realtimePremiumStyles';
    style.textContent = `
      .realtime-card{border-color:#2f8a62;background:linear-gradient(135deg,#f8fffb,#eefaf4)}
      .realtime-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
      .realtime-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.realtime-actions button{border:2px solid var(--ink);border-radius:12px;background:#dcf5e8;padding:9px 12px;font-weight:900;color:var(--ink)}
      .realtime-status{color:var(--muted);line-height:1.65;margin:8px 0 0}.realtime-table{display:grid;gap:8px;margin-top:12px}
      .realtime-row{display:grid;grid-template-columns:1.1fr .85fr .7fr .7fr 1.3fr;gap:8px;align-items:center;padding:10px;border-radius:12px;background:#fff;border:1px solid #d8eadf}
      .realtime-row.header{background:#e8f6ef;font-weight:950}.realtime-row b{font-size:18px}.premium-low{color:#2f8a62}.premium-mid{color:#a06b00}.premium-high{color:#bd4c62}.tiny{font-size:12px;color:var(--muted);line-height:1.45}.fresh-ok{color:#2f8a62}.fresh-warn{color:#a06b00}.fresh-bad{color:#bd4c62}
      .visual-alert{margin-top:12px;padding:12px;border-radius:14px;border:2px solid #2f8a62;background:#effbf4;line-height:1.7;font-weight:850}.visual-alert.empty{border-color:#d7e2ec;background:#fff;color:var(--muted);font-weight:700}
      @media(max-width:760px){.realtime-row{grid-template-columns:1fr 1fr}.realtime-row.header{display:none}.realtime-row span::before{display:block;font-size:11px;color:var(--muted);font-weight:700}.realtime-row span:nth-child(2)::before{content:'溢价口径'}.realtime-row span:nth-child(3)::before{content:'最新价'}.realtime-row span:nth-child(4)::before{content:'日涨跌'}.realtime-row span:nth-child(5)::before{content:'可靠性'}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    ensureStyles();
    let panel = document.getElementById('realtimePremiumPanel');
    if (panel) return panel;
    panel = document.createElement('article');
    panel.id = 'realtimePremiumPanel';
    panel.className = 'card realtime-card';
    panel.innerHTML = `
      <div class="realtime-head">
        <div>
          <div class="section-label">场内额外仓监控</div>
          <h2>低溢价主动提醒</h2>
          <p class="realtime-status" id="realtimeStatus">准备读取盘中溢价…</p>
        </div>
        <div class="realtime-actions">
          <button id="realtimeRefreshBtn">立即刷新</button>
          <button id="enablePremiumNotifyBtn">开启提醒</button>
        </div>
      </div>
      <div id="realtimeVisualAlert" class="visual-alert empty">低于5%会提示“观察区”，低于3%会提示“底仓区”。提醒只用于场内额外买入，不影响场外每日300元。</div>
      <div class="realtime-table" id="realtimePremiumTable"></div>
      <p class="tiny">说明：优先使用“实时价÷IOPV”口径；如果公开接口暂未给出稳定IOPV，则降级展示公开页面溢价。只有交易时段且时间足够新的数据才会触发提醒；下单前仍以券商APP实时IOPV/溢价为最终核对。</p>
    `;
    const home = document.getElementById('home');
    const warning = document.querySelector('#home .warning-card');
    if (home && warning) home.insertBefore(panel, warning);
    else document.querySelector('.page')?.insertBefore(panel, document.getElementById('loadStatus')?.nextSibling || null);

    document.getElementById('realtimeRefreshBtn')?.addEventListener('click', () => refreshRealtime(true));
    document.getElementById('enablePremiumNotifyBtn')?.addEventListener('click', enableNotifications);
    updateNotifyButton();
    return panel;
  }

  function updateNotifyButton() {
    const btn = document.getElementById('enablePremiumNotifyBtn');
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
      new Notification('纳指ETF低溢价提醒已开启', {body: '页面打开时，首次进入5%/3%会提醒；同一状态不会重复轰炸。'});
    } else {
      localStorage.setItem(ENABLE_KEY, '0');
      updateNotifyButton();
    }
  }

  function stateLabel(premium) {
    if (!ok(premium)) return ['暂无', ''];
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

  function renderRealtime(rows, errors, forced) {
    const table = document.getElementById('realtimePremiumTable');
    const status = document.getElementById('realtimeStatus');
    if (!table || !status) return;
    const now = cnParts();
    const trading = isTradingSession();
    const valid = rows.filter(row => ok(row.premium)).sort((a, b) => a.premium - b.premium);
    const alertable = valid.filter(row => row.canAlert).length;
    status.textContent = `${forced ? '手动刷新' : '自动刷新'}：${now.date} ${now.time}｜${trading ? 'A股交易中，约60秒刷新' : '非A股交易时段，约5分钟刷新；不触发盘中提醒'}｜成功 ${valid.length}/12，可提醒 ${alertable}/12，失败 ${errors.length}/12`;

    const cells = valid.map(row => {
      const [label, cls] = stateLabel(row.premium);
      const freshCls = freshnessClass(row.freshness);
      return `<div class="realtime-row">
        <span><strong>${row.code} ${row.company}</strong><div class="tiny">${row.name}</div></span>
        <span><b class="${cls}">${fmtPct(row.premium)}</b><div class="tiny">${label}｜${row.sourceLabel || row.source}</div></span>
        <span>${ok(row.price) ? fmt(row.price, 3) : '暂无'}${ok(row.iopv) ? `<div class="tiny">IOPV ${fmt(row.iopv, 4)}</div>` : ''}</span>
        <span class="${num(row.change) < 0 ? 'premium-high' : 'premium-low'}">${ok(row.change) ? fmtPct(row.change) : '暂无'}</span>
        <span><b class="tiny ${freshCls}">${row.freshLabel || '未校验'}</b><div class="tiny">${row.sourceTime || '未知时间'}</div></span>
      </div>`;
    }).join('');
    table.innerHTML = `<div class="realtime-row header"><span>ETF</span><span>溢价口径</span><span>最新价</span><span>日涨跌</span><span>可靠性</span></div>${cells || '<div class="empty">盘中溢价暂不可用，不触发提醒。</div>'}`;

    if (window.NDXDashboard?.setRealtimeRows) window.NDXDashboard.setRealtimeRows(rows);

    const primary = localStorage.getItem(PRIMARY_KEY) || window.NDXDashboard?.getPrimaryCode?.() || DEFAULT_PRIMARY;
    const primaryRow = valid.find(row => row.code === primary);
    if (primaryRow) updatePrimaryDisplay(primaryRow);
    else markPrimaryRealtimeMissing(primary);
  }

  function updatePrimaryDisplay(row) {
    const text = `${fmtPct(row.premium)}（盘中）`;
    ['heroPremium', 'holdingPremium', 'myPremium', 'premiumCardValue'].forEach(id => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    });
    const note = document.getElementById('premiumCardNote');
    const [label] = stateLabel(row.premium);
    if (note) note.textContent = `盘中${label}｜${row.freshLabel || '未校验'}｜${row.sourceLabel || row.source}`;
    const source = document.getElementById('sourceNote');
    if (source) source.textContent = '日频数据 + 盘中公开溢价源';
  }

  function markPrimaryRealtimeMissing(code) {
    const note = document.getElementById('premiumCardNote');
    if (note) note.textContent = `${code} 盘中溢价获取失败，不用其他ETF替代。`;
  }

  function notifyLowPremium(rows) {
    const state = loadAlertState();
    state.lastPremium ||= {};
    state.armed ||= {};
    const visual = document.getElementById('realtimeVisualAlert');
    const messages = [];

    rows.filter(row => ok(row.premium)).forEach(row => {
      const previous = state.lastPremium[row.code];
      const target = row.premium <= 3 ? 3 : row.premium <= 5 ? 5 : null;
      if (target && row.canAlert) {
        const key = `${row.code}-${target}`;
        const crossed = !ok(previous) || Number(previous) > target;
        if (crossed && state.armed[key] !== true) {
          const label = target === 3 ? '底仓区' : '观察区';
          const msg = `${label}：${row.code} ${row.company} 盘中溢价 ${fmtPct(row.premium)}，${row.freshLabel || ''}，来源 ${row.sourceLabel || row.source}`;
          messages.push(msg);
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

    if (visual) {
      if (messages.length) {
        visual.classList.remove('empty');
        visual.innerHTML = messages.map(x => `<div>🔔 ${x}</div>`).join('');
      } else {
        visual.classList.add('empty');
        visual.textContent = isTradingSession()
          ? '暂未触发低溢价提醒。只有交易时段、时间足够新、首次进入5%/3%才提醒。'
          : '当前非A股交易时段：显示数据但不触发盘中低溢价提醒。';
      }
    }

    const enabled = localStorage.getItem(ENABLE_KEY) === '1';
    if (enabled && 'Notification' in window && Notification.permission === 'granted') {
      messages.forEach(message => new Notification('纳指ETF低溢价提醒', {body: message}));
    }
  }

  async function refreshRealtime(forced = false) {
    ensurePanel();
    const table = document.getElementById('realtimePremiumTable');
    if (table) table.innerHTML = '<div class="empty">正在读取盘中溢价…</div>';
    const quoteMap = await fetchEastmoneyQuotes().catch(() => new Map());
    const results = await Promise.allSettled(ETF_LIST.map(async item => {
      const published = await fetchHaoPremium(item.code);
      const quote = quoteMap.get(item.code) || {};
      const merged = mergePremium(item, published, quote);
      const fresh = classifyFreshness(merged.sourceTime || quote.quoteTime);
      return {...merged, ...fresh, freshLabel: fresh.label};
    }));
    const rows = results.filter(x => x.status === 'fulfilled').map(x => x.value);
    const errors = results.filter(x => x.status === 'rejected').map(x => x.reason?.message || String(x.reason));
    renderRealtime(rows, errors, forced);
    notifyLowPremium(rows);
  }

  function loop() {
    refreshRealtime(false).finally(() => setTimeout(loop, isTradingSession() ? REFRESH_OPEN : REFRESH_CLOSED));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loop);
  else loop();
})();
