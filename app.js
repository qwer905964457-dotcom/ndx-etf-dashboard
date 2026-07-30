const NA = '暂无数据';
const DEFAULT_PRIMARY = '513390';
const HOLDING_KEY = 'ndx-primary-etf-code';
const PLAN = {
  otcDaily: 300,
  otcLabel: '场外300元/交易日',
  fieldLabel: '场内低溢价额外买入'
};

let DATA = null;
let activeFilter = 'all';
let REALTIME_ROWS = [];

const el = id => document.getElementById(id);
const set = (id, value) => { const node = el(id); if (node) node.textContent = value; };
const ok = value => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || ['-', '--', '暂无数据', 'null', 'None', 'NaN'].includes(text)) return false;
  }
  return Number.isFinite(Number(value));
};
const num = value => ok(value) ? Number(value) : null;
const fmt = (value, suffix = '', digits = 2) => ok(value) ? `${Number(value).toFixed(digits).replace(/\.00$/, '')}${suffix}` : NA;
const fmtPct = value => fmt(value, '%');

function funds(){ return Array.isArray(DATA?.funds) ? DATA.funds : []; }
function byCode(code){ return funds().find(f => String(f.code) === String(code)); }
function bestByScore(){
  return [...funds()].filter(f => ok(f.score)).sort((a,b)=>Number(b.score)-Number(a.score))[0]
    || [...funds()].filter(f => ok(f.premium)).sort((a,b)=>Number(a.premium)-Number(b.premium))[0]
    || funds()[0];
}
function primaryCode(){
  const saved = localStorage.getItem(HOLDING_KEY);
  if (saved && byCode(saved)) return saved;
  const configured = DATA?.settings?.primary_etf;
  if (configured && byCode(configured)) return String(configured);
  if (byCode(DEFAULT_PRIMARY)) return DEFAULT_PRIMARY;
  return bestByScore()?.code;
}
function primaryFund(){ return byCode(primaryCode()) || bestByScore(); }
function realtimeByCode(code){ return REALTIME_ROWS.find(row => String(row.code) === String(code)); }
function hasReliableRealtime(row){ return row && ok(row.premium) && ['realtime','delayed','today'].includes(row.freshness); }
function displayPremiumFor(fund){
  const live = realtimeByCode(fund?.code);
  if (hasReliableRealtime(live)) return {value: num(live.premium), source: live.sourceLabel || live.source || '公开实时源', time: live.sourceTime || '', live};
  return {value: num(fund?.premium), source: fund?.premium_source || '日频数据', time: fund?.premium_date || ''};
}

function premiumSeries(code){
  const store = DATA?.history?.premium_by_code || DATA?.premium_history || {};
  const raw = Array.isArray(store?.[code]) ? store[code] : [];
  return raw
    .map(item => ({date: item.date || item.premium_date || '', value: num(item.value ?? item.premium)}))
    .filter(item => item.date && ok(item.value))
    .sort((a,b)=>a.date.localeCompare(b.date));
}
function withCurrentPoint(series, fund){
  const current = num(fund?.premium);
  const date = fund?.premium_date || DATA?.market_data_as_of || DATA?.checked_at || '';
  const rows = [...series];
  if (ok(current) && date && !rows.some(x => x.date === date)) rows.push({date, value: current});
  return rows.sort((a,b)=>a.date.localeCompare(b.date));
}
function percentileOf(values, current){
  if (!Array.isArray(values) || values.length < 5 || !ok(current)) return null;
  const belowOrEqual = values.filter(v => v <= current).length;
  return Math.round((belowOrEqual / values.length) * 100);
}
function statsFor(fund){
  const rows = withCurrentPoint(premiumSeries(String(fund?.code || '')), fund);
  const values = rows.map(x=>x.value).filter(ok);
  const last30 = values.slice(-30);
  const last180 = values.slice(-180);
  const current = num(fund?.premium);
  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const min = arr => arr.length ? Math.min(...arr) : null;
  const max = arr => arr.length ? Math.max(...arr) : null;
  return {
    rows, values, count: values.length, current,
    avg30: avg(last30), min30: min(last30), max30: max(last30), pct30: percentileOf(last30, current),
    avg180: avg(last180), min180: min(last180), max180: max(last180), pct180: percentileOf(last180, current)
  };
}
function percentileLabel(pct, count){
  if (!ok(pct)) return count && count < 5 ? `样本${count}个，累积中` : '样本累积中';
  if (pct <= 20) return `第${pct}百分位｜近阶段较便宜`;
  if (pct <= 60) return `第${pct}百分位｜正常区间`;
  if (pct <= 80) return `第${pct}百分位｜偏贵`;
  return `第${pct}百分位｜很贵`;
}
function drawdownInfo(){
  const r = DATA?.risk || {};
  const hist = Array.isArray(DATA?.history?.ndx) ? DATA.history.ndx : [];
  const values = hist.map(x=>num(x.value)).filter(ok);
  const current = num(r.ndx) ?? values[values.length - 1];
  if (values.length >= 5 && ok(current)) {
    const high = Math.max(...values);
    return {value: (current / high - 1) * 100, high, source: `近${values.length}个交易日`};
  }
  if (ok(r.drawdown_from_high)) {
    return {value: num(r.drawdown_from_high), high: null, source: r.ndx_source ? `${r.ndx_source}阶段数据` : '阶段数据'};
  }
  const riskErrors = DATA?.update_status?.errors || [];
  const hasRiskError = Array.isArray(riskErrors) && riskErrors.some(x => String(x).includes('^NDX'));
  return {value: null, high: null, source: hasRiskError ? '纳指历史行情源失败，等待下次自动更新' : '等待纳指历史行情源'};
}
function classifyVix(vix){
  if (!ok(vix)) return ['未知', 'VIX数据暂不可用'];
  if (vix < 16) return ['平静', '市场情绪偏平静，少做冲动加仓'];
  if (vix < 22) return ['正常', '市场波动正常，基础定投照常执行'];
  if (vix < 30) return ['紧张', '市场开始紧张，额外加仓要分批'];
  return ['恐慌', '恐慌升温，机会和波动会一起变大'];
}
function fieldSignal(premium){
  if (!ok(premium)) return {level:'unknown', title:'场内等可靠溢价', score:50, note:'实时溢价不可用时，不触发额外买入。'};
  if (premium <= 3) return {level:'strong', title:'底仓区：认真评估加仓', score:88, note:'场内溢价≤3%，适合把它当额外买入/子弹加仓窗口。'};
  if (premium <= 5) return {level:'watch', title:'观察区：可小额额外买入', score:74, note:'场内溢价≤5%，可以小额额外买，或者准备下一档子弹。'};
  if (premium <= 7) return {level:'small', title:'可小口，但别重仓', score:58, note:'溢价不算舒服，只适合小口，不为凑金额硬买。'};
  if (premium <= 9) return {level:'wait', title:'偏高：场内先等', score:38, note:'场内额外仓暂停，场外300元基础仓照常。'};
  return {level:'stop', title:'高溢价：基本只看不买', score:25, note:'这已经是别人吃溢价的阶段，不适合拿场内大钱追。'};
}
function currentPrimaryPremium(){
  const fund = primaryFund();
  return displayPremiumFor(fund);
}

function ensurePersonalPlanCard(){
  if (el('personalPlanCard')) return;
  const home = el('home');
  const anchor = home?.querySelector('.three-col');
  if (!home || !anchor) return;
  const card = document.createElement('article');
  card.id = 'personalPlanCard';
  card.className = 'card gold-card personal-plan-card';
  card.innerHTML = `
    <div class="section-label">你的真实执行口径</div>
    <h2>场外每日300照常，场内只做低溢价额外买入</h2>
    <div class="metrics three">
      <div><span>基础定投</span><b>${PLAN.otcLabel}</b></div>
      <div><span>场内观察</span><b>≤5%观察区</b></div>
      <div><span>场内进攻</span><b>≤3%底仓区</b></div>
    </div>
    <p class="reason">场外300是长期基础仓，不因为场内溢价高低而停止；实时溢价提醒只用于“额外场内买入/子弹加仓”，不为了凑金额硬买高溢价。</p>
  `;
  home.insertBefore(card, anchor);
}

function renderHeader(){
  const fund = primaryFund();
  const premium = currentPrimaryPremium();
  const signal = fieldSignal(premium.value);
  const stats = statsFor(fund);
  set('updatedAt', DATA?.updated_at || DATA?.checked_at || NA);
  set('marketDate', DATA?.market_data_as_of || fund?.premium_date || NA);
  set('sourceNote', premium.live ? '日频数据 + 盘中公开溢价源' : (DATA?.source_note_short || '公开页面抓取，失败时保留旧值'));
  set('heroScore', `${signal.score}分`);
  set('heroHolding', fund ? `${fund.code} ${fund.company}` : NA);
  set('heroPremium', ok(premium.value) ? `${fmtPct(premium.value)}${premium.live ? '（盘中）' : ''}` : NA);
  set('heroPercentile', percentileLabel(stats.pct180 ?? stats.pct30, stats.count));
  set('heroAction', `${PLAN.otcLabel} + ${signal.title}`);
}

function renderHome(){
  ensurePersonalPlanCard();
  const fund = primaryFund();
  const stats = statsFor(fund);
  const premium = currentPrimaryPremium();
  const signal = fieldSignal(premium.value);
  const draw = drawdownInfo();
  const [vixState, vixNote] = classifyVix(num(DATA?.risk?.vix));

  set('actionTitle', '场外300照常；场内等低溢价');
  set('scoreRing', `${signal.score}`);
  set('actionText', `基础计划：${PLAN.otcLabel}；额外场内买入只在低溢价信号触发后评估。`);
  set('holdingCode', fund?.code || NA);
  set('holdingName', fund ? `${fund.company}${fund.name || '纳指100 ETF'}` : NA);
  set('holdingPremium', ok(premium.value) ? `${fmtPct(premium.value)}${premium.live ? '（盘中）' : ''}` : NA);
  set('holdingPercentile', percentileLabel(stats.pct180 ?? stats.pct30, stats.count));
  set('holdingFee', fmtPct(fund?.fee));
  set('holdingSamples', stats.count ? `${stats.count}个` : '累积中');
  set('holdingReason', `${signal.note} 数据口径：${premium.source}${premium.time ? `｜${premium.time}` : ''}。`);

  const reasons = [];
  reasons.push(`基础仓：${PLAN.otcLabel}，不断供，不被场内高溢价打断。`);
  reasons.push(ok(premium.value) ? `场内主ETF溢价：${fmtPct(premium.value)}，${signal.title}。` : '场内实时溢价不可用：不触发额外买入。');
  reasons.push(ok(stats.avg30) ? `日频历史：近30个样本均值 ${fmtPct(stats.avg30)}，区间 ${fmtPct(stats.min30)} ~ ${fmtPct(stats.max30)}。` : '历史溢价样本正在自动累积，暂时先按绝对溢价区间执行。');
  reasons.push(ok(draw.value) ? `纳指较${draw.source}高点回撤 ${fmtPct(draw.value)}。` : `纳指回撤数据：${draw.source}。`);
  reasons.push(`VIX：${fmt(DATA?.risk?.vix)}，${vixNote}。`);
  const list = el('actionReasons');
  if (list) list.innerHTML = reasons.map(x=>`<li>${x}</li>`).join('');

  set('premiumCardValue', ok(premium.value) ? fmtPct(premium.value) : NA);
  set('premiumCardNote', `${signal.title}${premium.live ? `｜${premium.time || '盘中源'}` : '｜日频口径'}`);
  set('drawdownCardValue', ok(draw.value) ? fmtPct(draw.value) : NA);
  set('drawdownCardNote', ok(draw.value) ? `${draw.source}高点以来` : draw.source);
  set('vixCardValue', fmt(DATA?.risk?.vix));
  set('vixCardNote', vixState);

  const p = premium.value;
  const change1 = num(DATA?.risk?.change1);
  const isFalling = ok(change1) && change1 < -1;
  let warning = '场内额外仓只看“纳指回撤 + 溢价收敛”的组合信号；单纯下跌不等于机会。';
  if (ok(p)) {
    if (p >= 9) warning = '主ETF溢价已经很高，场内额外买入暂停；场外300元基础仓照常。';
    else if (p >= 7) warning = isFalling ? '纳指下跌但溢价仍偏高，说明国内买盘在抢，不建议因为指数跌就追场内。' : '溢价偏高，场内额外仓先慢一点。';
    else if (p <= 5) warning = '主ETF溢价进入低溢价区，场内额外买入可以开始评估；仍然别一把梭。';
  }
  set('fallPremiumWarning', warning);
}

function renderHoldingSelector(){
  const select = el('holdingSelect');
  if (!select) return;
  const selected = String(primaryCode());
  select.innerHTML = funds().map(f => `<option value="${f.code}" ${String(f.code)===selected?'selected':''}>${f.code}｜${f.company}${f.name || '纳指100 ETF'}</option>`).join('');
  set('holdingConfigNote', DATA?.settings?.primary_note || '选择后会保存在当前浏览器，首页只分析这一只。');
}
function renderMyEtf(){
  const fund = primaryFund();
  const stats = statsFor(fund);
  set('myTitle', fund ? `${fund.code} ${fund.company}｜我的ETF档案` : '我的ETF档案');
  const premium = currentPrimaryPremium();
  set('myPremium', ok(premium.value) ? `${fmtPct(premium.value)}${premium.live ? '（盘中）' : ''}` : NA);
  set('myAvg30', fmtPct(stats.avg30));
  set('myPct180', percentileLabel(stats.pct180 ?? stats.pct30, stats.count));
  set('myFee', fmtPct(fund?.fee));
  renderSpark('premiumSpark', stats.rows, '%');

  const rules = [
    `场外基金：每个基金交易日固定买 ${PLAN.otcDaily} 元，这是长期基础仓，不看场内溢价。`,
    '场内ETF：只作为额外买入通道，不为凑满月度金额硬买。',
    '实时溢价 ≤ 5%：进入观察区，可以小额额外买入或准备子弹。',
    '实时溢价 ≤ 3%：进入底仓区，才适合更认真评估加仓。',
    '实时溢价 > 7%：不做大额场内买入；>9%基本只看不买。',
    '纳指下跌 + 溢价收敛，才是更好的场内额外买入窗口。'
  ];
  const plan = el('planList');
  if (plan) plan.innerHTML = rules.map(x=>`<li>${x}</li>`).join('');
}

function renderSpark(id, rows, suffix=''){
  const box = el(id);
  if (!box) return;
  const values = Array.isArray(rows) ? rows.map(x=>x.value).filter(ok) : [];
  if (!Array.isArray(rows) || rows.length < 2 || values.length < 2) {
    box.textContent = rows?.length ? `已有 ${rows.length} 个样本，继续累积后显示趋势` : '历史数据累积中';
    box.classList.add('placeholder');
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const recent = rows.filter(item => ok(item.value)).slice(-60);
  box.classList.remove('placeholder');
  box.innerHTML = `<div class="bars">${recent.map(item => {
    const h = 14 + ((item.value - min) / span) * 72;
    return `<i style="height:${h}%" title="${item.date}: ${fmt(item.value, suffix)}"></i>`;
  }).join('')}</div><p>${recent[0].date} → ${recent[recent.length - 1].date}</p>`;
}

function pass(f){
  const premium = displayPremiumFor(f).value;
  const fee = num(f.fee);
  if (activeFilter === 'under7') return ok(premium) && premium <= 7;
  if (activeFilter === 'high') return ok(premium) && premium >= 9;
  if (activeFilter === 'lowfee') return ok(fee) && fee <= 0.65;
  return true;
}
function sortedFunds(kind){
  const list = funds().filter(pass);
  const n = value => ok(value) ? Number(value) : 999;
  if (kind === 'premium') return list.sort((a,b)=>n(displayPremiumFor(a).value)-n(displayPremiumFor(b).value));
  if (kind === 'fee') return list.sort((a,b)=>n(a.fee)-n(b.fee));
  return list.sort((a,b)=>(num(b.score) ?? -1) - (num(a.score) ?? -1));
}
function renderRankLists(){
  const lowest = [...funds()].filter(f=>ok(displayPremiumFor(f).value)).sort((a,b)=>Number(displayPremiumFor(a).value)-Number(displayPremiumFor(b).value)).slice(0,5);
  const lowFee = [...funds()].filter(f=>ok(f.fee)).sort((a,b)=>Number(a.fee)-Number(b.fee) || (num(displayPremiumFor(a).value) ?? 99)-(num(displayPremiumFor(b).value) ?? 99)).slice(0,5);
  const row = (f,i,field) => `<div class="rank-row"><span>${i+1}</span><b>${f.code} ${f.company}</b><em>${field === 'fee' ? fmtPct(f.fee) : fmtPct(displayPremiumFor(f).value)}</em></div>`;
  const lbox = el('lowestList'); if (lbox) lbox.innerHTML = lowest.map((f,i)=>row(f,i,'premium')).join('') || NA;
  const fbox = el('feeList'); if (fbox) fbox.innerHTML = lowFee.map((f,i)=>row(f,i,'fee')).join('') || NA;
}
function renderFunds(){
  const box = el('fundList');
  if (!box) return;
  const sort = el('sortSelect')?.value || 'score';
  const selected = String(primaryCode());
  const list = sortedFunds(sort);
  box.innerHTML = list.map(f => {
    const stats = statsFor(f);
    const pct = stats.pct180 ?? stats.pct30;
    const isPrimary = String(f.code) === selected;
    const premium = displayPremiumFor(f);
    const sourceTag = ok(premium.value) ? (premium.live ? '盘中' : '日频') : '暂无';
    return `<article class="fund-item ${isPrimary?'primary':''}">
      <div class="fund-head">
        <div><strong>${f.code} ${f.company}</strong><div>${f.name || '纳指100 ETF'} ${isPrimary ? '<span class="tiny-badge">首页主角</span>' : ''}</div></div>
        <div class="premium">${fmtPct(premium.value)}</div>
      </div>
      <div class="details">
        <div>综合评分<b>${fmt(f.score, '', 0)}</b></div>
        <div>综合费率<b>${fmtPct(f.fee)}</b></div>
        <div>历史位置<b>${percentileLabel(pct, stats.count)}</b></div>
        <div>溢价口径<b>${sourceTag}</b></div>
      </div>
      <button class="set-primary" data-primary="${f.code}">${isPrimary ? '已是长期持仓' : '设为长期持仓'}</button>
    </article>`;
  }).join('') || `<article class="fund-item">${NA}</article>`;
}

function renderOtc(){
  const list = DATA?.otc_limits || DATA?.off_exchange_limits || [];
  set('otcNote', `你的执行口径：场外每日 ${PLAN.otcDaily} 元。下方限额快照只作通道参考，额度变化很快。`);
  const box = el('otcList');
  if (!box) return;
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<div class="empty">场外限购排行已预留位置，后续接入自动数据后展示。</div>';
    return;
  }
  box.innerHTML = list.map((item, index) => `<article class="otc-item">
    <div><span class="rank">${index + 1}</span><b>${item.limit_yuan ?? 0} 元/日</b><em>${item.status || ''}</em></div>
    <p>${(item.funds || []).join('、')}</p>
    ${item.note ? `<small>${item.note}</small>` : ''}
  </article>`).join('');
}
function renderMarket(){ renderRankLists(); renderFunds(); renderOtc(); }

function renderRisk(){
  const r = DATA?.risk || {};
  const draw = drawdownInfo();
  const [vixState, vixNote] = classifyVix(num(r.vix));
  const rows = [
    ['VIX恐慌指数', fmt(r.vix)],
    ['纳指100指数', fmt(r.ndx)],
    ['单日涨跌', fmtPct(r.change1)],
    ['近20日涨跌', fmtPct(r.change20)],
    ['20日年化波动率', fmtPct(r.vol20)],
    ['60日年化波动率', fmtPct(r.vol60)],
    ['PE（TTM）', fmt(r.pe)],
    ['距阶段高点', ok(draw.value) ? fmtPct(draw.value) : NA]
  ];
  const box = el('riskGrid');
  if (box) box.innerHTML = rows.map(([k,v])=>`<div class="risk-row"><span>${k}</span><b>${v}</b></div>`).join('');
  set('trendVix', fmt(r.vix));
  set('trendNdx', fmt(r.ndx));
  set('trendVol', fmtPct(r.vol20));
  const riskSource = [r.ndx_source, r.vix_source].filter(Boolean).join(' / ') || '等待行情源';
  set('valuationSummary', `当前VIX状态：${vixState}。${vixNote}。行情源：${riskSource}；PE/PB如果抓取不到，会保持“暂无数据”，不硬填。`);
  renderSpark('vixSpark', Array.isArray(DATA?.history?.vix) ? DATA.history.vix : [], '');
  renderSpark('ndxSpark', Array.isArray(DATA?.history?.ndx) ? DATA.history.ndx : [], '');
}
function renderDataCenter(){
  const status = DATA?.update_status || {};
  const historyStore = DATA?.history?.premium_by_code || {};
  const sampleTotal = Object.values(historyStore).reduce((sum, rows)=>sum + (Array.isArray(rows) ? rows.length : 0), 0);
  const liveCount = REALTIME_ROWS.filter(row => ok(row.premium)).length;
  const rows = [
    ['页面版本', 'v3.1 数据空值修正版'],
    ['ETF数量', `${funds().length}只`],
    ['溢价历史样本', `${sampleTotal}条`],
    ['基金日频更新', `${status.funds_updated ?? 0}/12`],
    ['行情序列更新', `${status.risk_series_updated ?? 0}/2`],
    ['长期持仓默认值', DATA?.settings?.primary_etf || DEFAULT_PRIMARY],
    ['基础定投金额', `${PLAN.otcDaily}元/交易日（场外）`],
    ['盘中溢价源', liveCount ? `${liveCount}/12 可用` : '等待实时模块']
  ];
  const box = el('dataGrid');
  if (box) box.innerHTML = rows.map(([k,v])=>`<div class="risk-row"><span>${k}</span><b>${v}</b></div>`).join('');
  const errors = Array.isArray(status.errors) ? status.errors : [];
  const errBox = el('errorBox');
  if (errBox) errBox.textContent = errors.length ? errors.join('\n') : '暂无错误。';
}

function renderAll(){
  renderHeader();
  renderHome();
  renderHoldingSelector();
  renderMyEtf();
  renderMarket();
  renderRisk();
  renderDataCenter();
}
function setPrimary(code){
  if (!byCode(code)) return;
  localStorage.setItem(HOLDING_KEY, String(code));
  renderAll();
}
function switchPanel(target, button){
  document.querySelectorAll('[data-target]').forEach(x=>x.classList.toggle('active', x === button));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id === target));
  button?.scrollIntoView({behavior:'smooth', block:'nearest', inline:'center'});
  const tabs = el('mainTabs');
  if (tabs) window.scrollTo({top: tabs.getBoundingClientRect().top + window.scrollY - 4, behavior:'smooth'});
  history.replaceState(null, '', `#${target}`);
}
function bindUI(){
  document.querySelectorAll('[data-target]').forEach(b=>b.addEventListener('click',()=>switchPanel(b.dataset.target,b)));
  const initial = location.hash.replace('#','');
  const initialButton = document.querySelector(`[data-target="${initial}"]`);
  if (initialButton) switchPanel(initial, initialButton);

  document.addEventListener('click', event => {
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
      activeFilter = filterButton.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active', x === filterButton));
      if (DATA) renderFunds();
      return;
    }
    const primaryButton = event.target.closest('[data-primary]');
    if (primaryButton) setPrimary(primaryButton.dataset.primary);
  });
  el('sortSelect')?.addEventListener('change',()=>DATA&&renderFunds());
  el('saveHoldingBtn')?.addEventListener('click',()=>setPrimary(el('holdingSelect')?.value));
  el('holdingSelect')?.addEventListener('change',event=>setPrimary(event.target.value));
  el('refreshBtn')?.addEventListener('click',()=>location.reload());
}
async function start(){
  const status = el('loadStatus');
  try {
    const res = await fetch(`./data.json?v=${Date.now()}`, {cache:'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    if (!Array.isArray(DATA.funds)) throw new Error('funds字段格式错误');
    renderAll();
    if (status) { status.textContent = `已载入 ${DATA.funds.length} 只ETF数据；基础计划 ${PLAN.otcLabel}，首页固定分析 ${primaryCode()}`; status.classList.add('ok'); }
  } catch (error) {
    console.error(error);
    if (status) { status.textContent = `数据加载失败：${error.message}`; status.classList.add('error'); }
  }
}

window.NDXDashboard = {
  setRealtimeRows(rows = []) {
    REALTIME_ROWS = Array.isArray(rows) ? rows : [];
    if (DATA) renderAll();
  },
  getPrimaryCode: () => primaryCode(),
  plan: PLAN
};

bindUI();
start();
