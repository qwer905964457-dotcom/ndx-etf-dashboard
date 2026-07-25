const NA='暂无数据';
let DATA=null;
let activeFilter='all';
const el=id=>document.getElementById(id);
const set=(id,value)=>{const node=el(id);if(node)node.textContent=value;};
const ok=v=>Number.isFinite(v);
const fmt=(v,s='')=>ok(v)?`${v}${s}`:NA;

function choose(){
  const funds=DATA?.funds||[];
  const known=funds.filter(f=>ok(f.premium));
  const scored=funds.filter(f=>ok(f.score)).sort((a,b)=>b.score-a.score);
  const low=[...known].sort((a,b)=>a.premium-b.premium)[0];
  return {best:scored[0]||low,low,known};
}

function renderHeader(){
  const {known}=choose();
  set('updatedAt',DATA.updated_at||NA);
  set('sourceNote',DATA.source_note||NA);
  set('underFiveCount',`${known.filter(f=>f.premium<=5).length}只`);
  set('underThreeCount',`${known.filter(f=>f.premium<=3).length}只`);
  set('todayMove',fmt(DATA.risk?.change1,'%'));
}

function renderDecision(){
  const {best,low}=choose();
  set('bestCode',best?.code||NA);
  set('bestName',best?`${best.company}${best.name||'纳指100 ETF'}`:NA);
  set('bestGrade',best?.grade||(!best?NA:'按已知溢价临时推荐'));
  set('bestPremium',fmt(best?.premium,'%'));
  set('bestFee',fmt(best?.fee,'%'));
  set('bestTracking',best?.tracking||NA);
  set('bestReason',best?.reason||(!best?NA:'当前缺少完整评分数据，暂按已知溢价较低排序。'));
  set('lowestCode',low?.code||NA);
  set('lowestName',low?`${low.company}${low.name||'纳指100 ETF'}`:NA);
  set('lowestPremium',fmt(low?.premium,'%'));
  set('toThree',low?`${Math.max(0,low.premium-3).toFixed(2)}%`:NA);
  set('toFive',low?`${Math.max(0,low.premium-5).toFixed(2)}%`:NA);
  set('baseZone',!low?NA:low.premium<=3?'已在3%以内，为底仓区':low.premium<=5?'已在5%以内，为观察区':'尚未进入5%观察区');
  set('buySignal',!low?NA:low.premium<=3?'建议投入 10%～20%':low.premium<=5?'建议投入 5%～10%':low.premium<=10?'建议小仓观察':'建议继续等待');
  const checks=el('buyChecks');
  if(checks){
    checks.innerHTML=[
      `当前最低溢价：${fmt(low?.premium,'%')}`,
      `VIX恐慌指数：${fmt(DATA.risk?.vix)}`,
      `纳指100指数：${fmt(DATA.risk?.ndx)}`,
      `近20日涨跌：${fmt(DATA.risk?.change20,'%')}`,
      `20日波动率：${fmt(DATA.risk?.vol20,'%')}`
    ].map(x=>`<li>✅ ${x}</li>`).join('');
  }
}

function renderTop(){
  const box=el('topFunds');
  if(!box)return;
  let list=[...(DATA.funds||[])];
  const scored=list.filter(f=>ok(f.score));
  list=(scored.length?scored.sort((a,b)=>b.score-a.score):list.filter(f=>ok(f.premium)).sort((a,b)=>a.premium-b.premium)).slice(0,3);
  box.innerHTML=list.length?list.map((f,i)=>`<article class="mini"><span class="rank">${i+1}</span><strong>${f.code}</strong><p>${f.company}${f.name||'纳指100 ETF'}</p><div class="metrics three"><div><span>费率</span><b>${fmt(f.fee,'%')}</b></div><div><span>跟踪误差</span><b>${f.tracking||NA}</b></div><div><span>溢价</span><b>${fmt(f.premium,'%')}</b></div></div></article>`).join(''):`<p>${NA}</p>`;
}

function renderRisk(){
  const r=DATA.risk||{};
  const box=el('riskGrid');
  if(box){
    const rows=[['VIX恐慌指数',fmt(r.vix)],['纳指100指数',fmt(r.ndx)],['近20日涨跌幅',fmt(r.change20,'%')],['20日年化波动率',fmt(r.vol20,'%')],['60日年化波动率',fmt(r.vol60,'%')],['PE（TTM）',fmt(r.pe)]];
    box.innerHTML=rows.map(([k,v])=>`<div class="risk-row"><span>${k}</span><b>${v}</b></div>`).join('');
  }
  set('trendVix',fmt(r.vix));
  set('trendNdx',fmt(r.ndx));
  set('trendVol',fmt(r.vol20,'%'));
}

function pass(f){
  if(activeFilter==='under3')return ok(f.premium)&&f.premium<=3;
  if(activeFilter==='under5')return ok(f.premium)&&f.premium<=5;
  if(activeFilter==='wait')return ok(f.premium)&&f.premium>5;
  if(activeFilter==='weak')return f.tracking==='偏弱';
  return true;
}

function renderFunds(){
  const box=el('fundList');
  if(!box)return;
  const sort=el('sortSelect')?.value||'score';
  let list=(DATA.funds||[]).filter(pass);
  list.sort((a,b)=>sort==='premium'?((a.premium??999)-(b.premium??999)):((b.score??-1)-(a.score??-1)));
  box.innerHTML=list.map(f=>`<article class="fund-item"><div class="fund-head"><div><strong>${f.code} ${f.company}</strong><div>${f.name||'纳指100 ETF'}</div></div><div class="premium">${fmt(f.premium,'%')}</div></div><div class="details"><div>综合评分<b>${fmt(f.score)}</b></div><div>综合费率<b>${fmt(f.fee,'%')}</b></div><div>跟踪情况<b>${f.tracking||NA}</b></div><div>推荐等级<b>${f.grade||NA}</b></div></div></article>`).join('')||`<article class="fund-item">${NA}</article>`;
}

function switchPanel(target,button){
  document.querySelectorAll('[data-target]').forEach(x=>x.classList.toggle('active',x===button));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===target));
  button.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
  const tabs=el('mainTabs');
  if(tabs){window.scrollTo({top:tabs.getBoundingClientRect().top+window.scrollY-4,behavior:'smooth'});}
  history.replaceState(null,'',`#${target}`);
}

function bindUI(){
  document.querySelectorAll('[data-target]').forEach(b=>b.addEventListener('click',()=>switchPanel(b.dataset.target,b)));
  const initial=location.hash.replace('#','');
  const initialButton=document.querySelector(`[data-target="${initial}"]`);
  if(initialButton)switchPanel(initial,initialButton);

  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-filter]');
    if(!b)return;
    activeFilter=b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));
    if(DATA)renderFunds();
  });
  el('sortSelect')?.addEventListener('change',()=>DATA&&renderFunds());
  el('refreshBtn')?.addEventListener('click',()=>location.reload());
}

async function start(){
  const status=el('loadStatus');
  try{
    const res=await fetch(`./data.json?v=${Date.now()}`,{cache:'no-store'});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    DATA=await res.json();
    if(!Array.isArray(DATA.funds))throw new Error('funds字段格式错误');
    renderHeader();
    renderDecision();
    renderTop();
    renderRisk();
    renderFunds();
    if(status){status.textContent=`已载入 ${DATA.funds.length} 只ETF数据`;status.classList.add('ok');}
  }catch(e){
    console.error(e);
    if(status){status.textContent=`数据加载失败：${e.message}`;status.classList.add('error');}
  }
}

bindUI();
start();
