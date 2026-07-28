(() => {
  const DAILY_OTC = 300;
  const APPLY_INTERVAL = 1500;

  function el(id) { return document.getElementById(id); }
  function setText(id, value) {
    const node = el(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function ensurePersonalPlanCard() {
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
        <div><span>基础定投</span><b>场外300元/交易日</b></div>
        <div><span>场内观察</span><b>≤5%观察区</b></div>
        <div><span>场内进攻</span><b>≤3%底仓区</b></div>
      </div>
      <p class="reason">场外300是长期基础仓，不因为场内溢价高低而停止；实时溢价提醒只用于“额外场内买入/子弹加仓”，不为了凑金额硬买高溢价。</p>
    `;
    home.insertBefore(card, anchor);
  }

  function patchDecisionText() {
    setText('actionTitle', '场外300照常；场内等低溢价');
    setText('actionText', '基础计划：场外每交易日300元；额外场内买入只在低溢价提醒触发后评估。');
    setText('heroAction', '场外300 + 场内低溢价额外');
  }

  function patchPlanList() {
    const list = el('planList');
    if (!list) return;
    const html = [
      `场外基金：每个基金交易日固定买 ${DAILY_OTC} 元，这是长期基础仓，不看场内溢价。`,
      '场内ETF：只作为额外买入通道，不为凑满月度金额硬买。',
      '实时溢价 ≤ 5%：进入观察区，可以小额额外买入或准备子弹。',
      '实时溢价 ≤ 3%：进入底仓区，才适合更认真评估加仓。',
      '实时溢价 > 7%：不做大额场内买入；>9%基本只看不买。',
      '纳指下跌 + 溢价收敛，才是更好的场内额外买入窗口。'
    ].map(x => `<li>${x}</li>`).join('');
    if (list.innerHTML !== html) list.innerHTML = html;
  }

  function patchDataCenter() {
    document.querySelectorAll('#dataGrid .risk-row').forEach(row => {
      const label = row.querySelector('span')?.textContent?.trim();
      const value = row.querySelector('b');
      if (label === '每日定投金额' && value && value.textContent !== `${DAILY_OTC}元（场外）`) {
        value.textContent = `${DAILY_OTC}元（场外）`;
      }
    });
  }

  function patchRealtimeNote() {
    const alert = el('realtimeVisualAlert');
    if (!alert || el('realtimePlanNote')) return;
    const note = document.createElement('div');
    note.id = 'realtimePlanNote';
    note.className = 'tiny';
    note.style.marginTop = '8px';
    note.textContent = '提醒含义：这是场内额外买入信号，不影响场外每日300元基础定投。';
    alert.insertAdjacentElement('afterend', note);
  }

  function apply() {
    ensurePersonalPlanCard();
    patchDecisionText();
    patchPlanList();
    patchDataCenter();
    patchRealtimeNote();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }

  setInterval(apply, APPLY_INTERVAL);
})();
