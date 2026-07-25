const NA = '暂无数据';
const DEFAULT_PRIMARY = '513390';
const HOLDING_KEY = 'ndx-primary-etf-code';
let DATA = null;
let activeFilter = 'all';

const el = id => document.getElementById(id);
const set = (id, value) => { const node = el(id); if (node) node.textContent = value; };
const ok = value => Number.isFinite(Number(value));
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
  const current = num(r.ndx) ?? values.at(-1);
  if (values.length >= 5 && ok(current)) {
    const high = Math.max(...values);
    return {value: (current / high - 1) * 100, high, source: `近${values.length}个交易日`};
  }
  return {value: null, high: null, source: '等待行情源恢复'};
}
function classifyVix(vix){
  if (!ok(vix)) return ['未知', 'VIX数据暂不可用'];
  if (vix < 16) return ['平静', '市场情绪偏平静，少做冲动加仓'];
  if (vix < 22) return ['正常', '市场波动正常，适合按纪律定投'];
  if (vix < 30) return ['紧张', '市场开始紧张，可分批但别满仓'];
  return ['恐慌', '恐慌升温，机会和波动会一起变大'];
}
function actionFor(fund){
  const premium = num(fund?.premium);
  const stats = statsFor(fund);
  const pct = stats.pct180 ?? stats.pct30;
  const daily = DATA?.investment?.daily_amount_yuan ?? 200;
  let level = 'normal';
  let title = '正常定投';
  let amount = daily;
  let score = 60;

  if (!ok(premium)) {
    level = 'wait'; title = '先不机械买入'; amount = 0; score = 35;
  } else if ((ok(pct) && pct <= 20) || premium <= 5) {
    level = 'strong'; title = '正常定投，可略积极'; amount = daily; score = 82;
  } else if ((ok(pct) && pct <= 60) || premium <= 7) {
    level = 'normal'; title = '正常定投'; amount = daily; score = 68;
  } else if ((ok(pct) && pct <= 80) || premium <= 9) {
    level = 'half'; title = '半额定投'; amount = Math.round(daily / 2); score = 52;
  } else {
    level = 'wait'; title = '暂停，等溢价降温'; amount = 0; score = 32;
  }

  const draw = drawdownInfo().value;
  if (ok(draw) && draw <= -8 && level !== 'wait') score = Math.min(92, score + 8);
  const vix = num(DATA?.risk?.vix);
  if (ok(vix) && vix >= 30) score = Math.max(30, score - 8);

  return {level, title, amount, score, daily, pct, stats};
}

function renderHeader(){
  const fund = primaryFund();
  const action = actionFor(fund);
  const stats = action.stats;
  set('updatedAt', DATA?.updated_at || DATA?.checked_at || NA);
  set('marketDate', DATA?.market_data_as_of || fund?.premium_date || NA);
  set('sourceNote', DATA?.source_note_short || '公开页面抓取，失败时保留旧值');
  set('heroScore', `${action.score}分`);
  set('heroHolding', fund ? `${fund.code} ${fund.company}` : NA);
  set('heroPremium', fmtPct(fund?.premium));
  set('heroPercentile', percentileLabel(action.pct, stats.count));
  set('heroAction', action.title);
}

function renderHome(){
  const fund = primaryFund();
  const action = actionFor(fund);
  const stats = action.stats;
  const draw = drawdownInfo();
  const [vixState, vixNote] = classifyVix(num(DATA?.risk?.vix));

  set('actionTitle', action.title);
  set('scoreRing', `${action.score}`);
  set('actionText', action.amount > 0 ? `今日计划买入：约 ${action.amount} 元` : '今日计划买入：0 元，现金先留着');
  set('holdingCode', fund?.code || NA);
  set('holdingName', fund ? `${fund.company}${fund.name || '纳指100 ETF'}` : NA);
  set('holdingPremium', fmtPct(fund?.premium));
  set('holdingPercentile', percentileLabel(action.pct, stats.count));
  set('holdingFee', fmtPct(fund?.fee));
  set('holdingSamples', stats.count ? `${stats.count}个` : '累积中');
  set('holdingReason', fund?.reason || DATA?.settings?.primary_note || '首页固定分析这一只，避免每天在多只ETF之间来回切换。');

  const reasons = [];
  reasons.push(`当前溢价：${fmtPct(fund?.premium)}，${percentileLabel(action.pct, stats.count)}。`);
  reasons.push(ok(stats.avg30) ? `近30个样本均值：${fmtPct(stats.avg30)}，区间 ${fmtPct(stats.min30)} ~ ${fmtPct(stats.max30)}。` : '历史溢价样本正在自动累积，暂时先按绝对溢价区间执行。');
  reasons.push(ok(draw.value) ? `纳指较${draw.source}高点回撤 ${fmtPct(draw.value)}。` : `纳指回撤数据：${draw.source}。`);
  reasons.push(`VIX：${fmt(DATA?.risk?.vix)}，${vixNote}。`);
  const list = el('actionReasons');
  if (list) list.innerHTML = reasons.map(x=>`<li>${x}</li>`).join('');

  set('premiumCardValue', fmtPct(fund?.premium));
  set('premiumCardNote', percentileLabel(action.pct, stats.count));
  set('drawdownCardValue', ok(draw.value) ? fmtPct(draw.value) : NA);
  set('drawdownCardNote', ok(draw.value) ? `${draw.source}高点以来` : draw.source);
  set('vixCardValue', fmt(DATA?.risk?.vix));
  set('vixCardNote', vixState);

  const premium = num(fund?.premium);
  const change1 = num(DATA?.risk?.change1);
  const isFalling = ok(change1) && change1 < -1;
  let warning = '当前没有足够数据判断“越跌越贵”是否发生，后续会用溢价历史百分位自动识别。';
  if (ok(premium)) {
    if ((ok(action.pct) && action.pct >= 80) || premium >= 9) {
      warning = isFalling
        ? '纳指下跌时，这只ETF溢价仍处于偏高位置，说明国内买盘可能在抢筹；这时不建议因为指数跌了就追高。'
        : '这只ETF溢价处在偏高区间，即使你长期持有，也可以放慢买入节奏。';
    } else {
      warning = '溢价没有明显冲到历史高位；如果纳指下跌但溢价保持在正常百分位，按纪律定投即可。';
    }
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
  const action = actionFor(fund);
  set('myTitle', fund ? `${fund.code} ${fund.company}｜我的ETF档案` : '我的ETF档案');
  set('myPremium', fmtPct(fund?.premium));
  set('myAvg30', fmtPct(stats.avg30));
  set('myPct180', percentileLabel(stats.pct180 ?? stats.pct30, stats.count));
  set('myFee', fmtPct(fund?.fee));
  renderSpark('premiumSpark', stats.rows, '%');

  const daily = action.daily;
  const rules = [
    `历史百分位 ≤ 20% 或溢价 ≤ 5%：正常买 ${daily} 元，可把前面积累的现金补一部分。`,
    `历史百分位 20%～60% 或溢价 5%～7%：正常买 ${daily} 元。`,
    `历史百分位 60%～80% 或溢价 7%～9%：买半额，约 ${Math.round(daily/2)} 元。`,
    `历史百分位 > 80% 或溢价 > 9%：暂停，等抢筹情绪降温。`,
    '纳指下跌不是无脑加仓条件；只有“纳指回撤 + 溢价没冲高”才适合更积极。'
  ];
  const plan = el('planList');
  if (plan) plan.innerHTML = rules.map(x=>`<li>${x}</li>`).join('');
}

function renderSpark(id, rows, suffix=''){
  const box = el(id);
  if (!box) return;
  if (!Array.isArray(rows) || rows.length < 2) {
    box.textContent = rows?.length ? `已有 ${rows.length} 个样本，继续累积后显示趋势` : '历史数据累积中';
    box.classList.add('placeholder');
    return;
  }
  const values = rows.map(x=>x.value).filter(ok);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const recent = rows.slice(-60);
  box.classList.remove('placeholder');
  box.innerHTML = `<div class="bars">${recent.map(item => {
    const h = 14 + ((item.value - min) / span) * 72;
    return `<i style="height:${h}%" title="${item.date}: ${fmt(item.value, suffix)}"></i>`;
  }).join('')}</div><p>${recent[0].date} → ${recent.at(-1).date}</p>`;
}

function pass(f){
  const premium = num(f.premium);
  const fee = num(f.fee);
  if (activeFilter === 'under7') return ok(premium) && premium <= 7;
  if (activeFilter === 'high') return ok(premium) && premium >= 9;
  if (activeFilter === 'lowfee') return ok(fee) && fee <= 0.65;
  return true;
}
function sortedFunds(kind){
  const list = funds().filter(pass);
  const n = value => ok(value) ? Number(value) : 999;
  if (kind === 'premium') return list.sort((a,b)=>n(a.premium)-n(b.premium));
  if (kind === 'fee') return list.sort((a,b)=>n(a.fee)-n(b.fee));
  return list.sort((a,b)=>(num(b.score) ?? -1) - (num(a.score) ?? -1));
}
function renderRankLists(){
  const lowest = [...funds()].filter(f=>ok(f.premium)).sort((a,b)=>Number(a.premium)-Number(b.premium)).slice(0,5);
  const lowFee = [...funds()].filter(f=>ok(f.fee)).sort((a,b)=>Number(a.fee)-Number(b.fee) || Number(a.premium ?? 99)-Number(b.premium ?? 99)).slice(0,5);
  const row = (f,i,field) => `<div class="rank-row"><span>${i+1}</span><b>${f.code} ${f.company}</b><em>${field === 'fee' ? fmtPct(f.fee) : fmtPct(f.premium)}</em></div>`;
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
    return `<article class="fund-item ${isPrimary?'primary':''}">
      <div class="fund-head">
        <div><strong>${f.code} ${f.company}</strong><div>${f.name || '纳指100 ETF'} ${isPrimary ? '<span class="tiny-badge">首页主角</span>' : ''}</div></div>
        <div class="premium">${fmtPct(f.premium)}</div>
      </div>
      <div class="details">
        <div>综合评分<b>${fmt(f.score, '', 0)}</b></div>
        <div>综合费率<b>${fmtPct(f.fee)}</b></div>
        <div>历史位置<b>${percentileLabel(pct, stats.count)}</b></div>
        <div>数据日期<b>${f.premium_date || NA}</b></div>
      </div>
      <button class="set-primary" data-primary="${f.code}">${isPrimary ? '已是长期持仓' : '设为长期持仓'}</button>
    </article>`;
  }).join('') || `<article class="fund-item">${NA}</article>`;
}

function renderOtc(){
  const list = DATA?.otc_limits || DATA?.off_exchange_limits || [];
  set('otcNote', DATA?.otc_limits_note || '暂未接入自动场外额度数据源。');
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
function renderMarket(){
  renderRankLists();
  renderFunds();
  renderOtc();
}

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
  set('valuationSummary', `当前VIX状态：${vixState}。${vixNote}。估值PE/PB如果抓取不到，会保持“暂无数据”，不硬填。`);
  renderSpark('vixSpark', Array.isArray(DATA?.history?.vix) ? DATA.history.vix : [], '');
  renderSpark('ndxSpark', Array.isArray(DATA?.history?.ndx) ? DATA.history.ndx : [], '');
}
function renderDataCenter(){
  const status = DATA?.update_status || {};
  const historyStore = DATA?.history?.premium_by_code || {};
  const sampleTotal = Object.values(historyStore).reduce((sum, rows)=>sum + (Array.isArray(rows) ? rows.length : 0), 0);
  const rows = [
    ['页面版本', 'v2.0 长期投资模式'],
    ['ETF数量', `${funds().length}只`],
    ['溢价历史样本', `${sampleTotal}条`],
    ['基金溢价更新', `${status.funds_updated ?? 0}/12`],
    ['行情序列更新', `${status.risk_series_updated ?? 0}/2`],
    ['长期持仓默认值', DATA?.settings?.primary_etf || DEFAULT_PRIMARY],
    ['每日定投金额', `${DATA?.investment?.daily_amount_yuan ?? 200}元`]
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
    if (status) { status.textContent = `已载入 ${DATA.funds.length} 只ETF数据，首页固定分析 ${primaryCode()}`; status.classList.add('ok'); }
  } catch (error) {
    console.error(error);
    if (status) { status.textContent = `数据加载失败：${error.message}`; status.classList.add('error'); }
  }
}

bindUI();
start();
