/* ============================================================
   CONSTANTS
   ============================================================ */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_INDEX = Object.fromEntries(MONTHS.map((m,i)=>[m,i]));
const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/* ============================================================
   CSV PARSING (Fidelity Full View export format) — unchanged
   from the prior build.
   ============================================================ */
function parseCSVLine(line){
  const out = [];
  let cur = '', inQuotes = false;
  for (let i=0; i<line.length; i++){
    const c = line[i];
    if (inQuotes){
      if (c === '"'){
        if (line[i+1] === '"'){ cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ','){ out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}

function parseDate(s){
  // "Jan-05-2026" -> Date
  const m = s.trim().match(/^([A-Za-z]{3})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const abbrev = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const mi = MONTH_INDEX[abbrev];
  if (mi === undefined) return null;
  return new Date(parseInt(m[3],10), mi, parseInt(m[2],10));
}

function parseFidelityCSV(text, sourceName){
  const lines = text.split(/\r\n|\n|\r/);
  const footerIdx = lines.findIndex(l => l.includes('DATA GLOSSARY'));
  const end = footerIdx === -1 ? lines.length : footerIdx;
  if (lines.length < 2) throw new Error(`${sourceName}: file too short to contain a header row`);
  const header = parseCSVLine(lines[1]).map(h=>h.trim());
  const amtIdx = header.findIndex(h => h.startsWith('Amount'));
  if (amtIdx === -1) throw new Error(`${sourceName}: no "Amount" column found — is this a Fidelity Full View export?`);
  const idx = {
    date: header.indexOf('Date'),
    description: header.indexOf('Description'),
    amount: amtIdx,
    account: header.indexOf('Account Name'),
    type: header.indexOf('Transaction Type'),
    category: header.indexOf('Category'),
    subcategory: header.indexOf('Subcategory'),
    hidden: header.indexOf('Hidden Transaction'),
  };
  const missing = Object.entries(idx).filter(([k,v])=>v===-1 && k!=='hidden').map(([k])=>k);
  if (missing.length) throw new Error(`${sourceName}: missing expected column(s): ${missing.join(', ')}`);

  const rows = [];
  for (let i=2; i<end; i++){
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = parseCSVLine(raw);
    if (cells.length < header.length - 1) continue;
    if (idx.hidden !== -1 && cells[idx.hidden] === 'Yes') continue;
    const date = parseDate(cells[idx.date]);
    const amount = parseFloat(String(cells[idx.amount]).replace(/[$,]/g,''));
    if (!date || isNaN(amount)) continue;
    rows.push({
      date, amount,
      description: cells[idx.description] || '',
      account: cells[idx.account] || '',
      type: cells[idx.type] || '',
      category: cells[idx.category] || '',
      subcategory: cells[idx.subcategory] || '',
    });
  }
  return rows;
}

function dedupKey(r){
  return [r.date.toISOString().slice(0,10), r.description, r.amount, r.account, r.category, r.subcategory].join('|');
}

/* ============================================================
   AGGREGATION — extended to build an Income subcategory tree
   (flat: CSV "Category" field becomes the row) in addition to
   the existing Expenses category → subcategory tree.
   ============================================================ */
function aggregate(allRows, sourceFiles){
  const seen = new Set();
  const rows = [];
  for (const r of allRows){
    const k = dedupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(r);
  }

  // Detect the "year" this dataset represents (most common year among rows),
  // used for daily-frequency budget resolution (leap years etc).
  const yearCounts = new Map();
  rows.forEach(r=>{
    const y = r.date.getFullYear();
    yearCounts.set(y, (yearCounts.get(y)||0)+1);
  });
  let year = new Date().getFullYear();
  let bestCount = -1;
  yearCounts.forEach((count,y)=>{ if (count > bestCount){ bestCount = count; year = y; } });

  const monthsPresentSet = new Set();
  rows.forEach(r => monthsPresentSet.add(r.date.getMonth()));
  const monthsPresent = [...monthsPresentSet].sort((a,b)=>a-b);
  const currentMonthIndex = monthsPresent.length ? monthsPresent[monthsPresent.length-1] : null;

  const income = new Array(12).fill(0);
  rows.filter(r=>r.type==='Income').forEach(r=>{ income[r.date.getMonth()] += r.amount; });

  // Income subcategory tree — flat, keyed on CSV "Subcategory" (per product decision:
  // Income's Category is always "Income", so its row grouping is the Subcategory
  // field instead, no further drill-down for now).
  const incomeMap = new Map();
  rows.filter(r=>r.type==='Income').forEach(r=>{
    const mi = r.date.getMonth();
    const name = r.subcategory || '(Uncategorized)';
    if (!incomeMap.has(name)) incomeMap.set(name, new Array(12).fill(0));
    incomeMap.get(name)[mi] += r.amount;
  });
  const incomeSubcats = [...incomeMap.entries()].map(([name, monthly])=>({
    name,
    monthly: monthly.map(v=>Math.round(v*100)/100),
    yearly: Math.round(monthly.reduce((a,b)=>a+b,0)*100)/100,
  })).sort((a,b)=>b.yearly-a.yearly);

  // Expenses category -> subcategory tree, netting refunds (positive expense
  // amounts) against spending rather than abs()-ing them into extra spend.
  const catMap = new Map();
  rows.filter(r=>r.type==='Expenses').forEach(r=>{
    const mi = r.date.getMonth();
    if (!catMap.has(r.category)) catMap.set(r.category, new Map());
    const subMap = catMap.get(r.category);
    if (!subMap.has(r.subcategory)) subMap.set(r.subcategory, new Array(12).fill(0));
    subMap.get(r.subcategory)[mi] += -r.amount;
  });

  let categories = [...catMap.entries()].map(([name, subMap])=>{
    const subcategories = [...subMap.entries()].map(([sname, monthly])=>({
      name: sname,
      monthly: monthly.map(v=>Math.round(v*100)/100),
      yearly: Math.round(monthly.reduce((a,b)=>a+b,0)*100)/100,
    })).sort((a,b)=>b.yearly-a.yearly);
    const monthly = new Array(12).fill(0);
    subcategories.forEach(s=>s.monthly.forEach((v,i)=>monthly[i]+=v));
    return {
      name,
      monthly: monthly.map(v=>Math.round(v*100)/100),
      yearly: Math.round(monthly.reduce((a,b)=>a+b,0)*100)/100,
      subcategories,
    };
  }).sort((a,b)=>b.yearly-a.yearly);

  const expenses = new Array(12).fill(0);
  categories.forEach(c=>c.monthly.forEach((v,i)=>expenses[i]+=v));
  const net = income.map((v,i)=>Math.round((v-expenses[i])*100)/100);

  const transactions = rows.slice().sort((a,b)=>a.date-b.date).map(r=>({
    date: r.date.toISOString().slice(0,10),
    month: r.date.getMonth(),
    description: r.description,
    amount: Math.round(r.amount*100)/100,
    category: r.category,
    subcategory: r.subcategory,
    account: r.account,
    type: r.type,
  }));

  return {
    year, months: MONTHS, monthsPresent, currentMonthIndex,
    income: income.map(v=>Math.round(v*100)/100),
    incomeSubcats,
    expenses: expenses.map(v=>Math.round(v*100)/100),
    net, categories, transactions, sourceFiles,
  };
}

function emptyData(){
  return {
    year: new Date().getFullYear(), months: MONTHS, monthsPresent: [], currentMonthIndex: null,
    income: new Array(12).fill(0), incomeSubcats: [],
    expenses: new Array(12).fill(0), net: new Array(12).fill(0), categories: [],
    transactions: [], sourceFiles: [],
  };
}

/* ============================================================
   BUDGETS — line-item schema + resolver
   {
     "Expenses": { "<Category>": { "<Subcategory>": [ {freq,label,amount}, ... ] } },
     "Income":   { "<Subcategory>": [ {freq,label,amount}, ... ] }
   }
   freq: "monthly" (scalar or 12-array) | "daily" (scalar, x days-in-month) |
         3-letter month code ("jan".."dec", scalar, one-time).
   ============================================================ */
function daysInMonth(year, monthIndex){ return new Date(year, monthIndex+1, 0).getDate(); }

function resolveLineItem(item, year){
  const arr = new Array(12).fill(0);
  const freq = (item.freq||'').toLowerCase();
  if (freq === 'monthly'){
    if (Array.isArray(item.amount)){
      for (let i=0;i<12;i++) arr[i] = item.amount[i] || 0;
    } else {
      const v = Number(item.amount)||0;
      for (let i=0;i<12;i++) arr[i] = v;
    }
  } else if (freq === 'daily'){
    const v = Number(item.amount)||0;
    for (let i=0;i<12;i++) arr[i] = v * daysInMonth(year, i);
  } else {
    const mi = MONTH_ABBR.indexOf(freq);
    if (mi !== -1) arr[mi] = Number(item.amount)||0;
  }
  return arr.map(v=>Math.round(v*100)/100);
}

function resolveBudgets(raw, year){
  const result = { expenses: {}, income: {} };
  const expensesRaw = (raw && raw.Expenses) || {};
  Object.entries(expensesRaw).forEach(([catName, subs])=>{
    result.expenses[catName] = {};
    Object.entries(subs||{}).forEach(([subName, items])=>{
      const list = Array.isArray(items) ? items : [];
      const resolvedItems = list.map(it=>({ freq: it.freq, label: it.label||subName, amount: it.amount, monthly: resolveLineItem(it, year) }));
      const monthly = new Array(12).fill(0);
      resolvedItems.forEach(it=>it.monthly.forEach((v,i)=>monthly[i]+=v));
      result.expenses[catName][subName] = { monthly: monthly.map(v=>Math.round(v*100)/100), items: resolvedItems };
    });
  });
  const incomeRaw = (raw && raw.Income) || {};
  Object.entries(incomeRaw).forEach(([subName, items])=>{
    const list = Array.isArray(items) ? items : [];
    const resolvedItems = list.map(it=>({ freq: it.freq, label: it.label||subName, amount: it.amount, monthly: resolveLineItem(it, year) }));
    const monthly = new Array(12).fill(0);
    resolvedItems.forEach(it=>it.monthly.forEach((v,i)=>monthly[i]+=v));
    result.income[subName] = { monthly: monthly.map(v=>Math.round(v*100)/100), items: resolvedItems };
  });
  return result;
}

// Derived, aggregated views built once per render from the resolved budgets.
function buildBudgetRollups(resolved, categories, incomeSubcats){
  // Expense category monthly = sum of its subcats' monthly, SIGN-FLIPPED to a
  // positive "planned spend" magnitude (matches Actual sign convention).
  const expenseCategoryMonthly = {}; // catName -> [12] positive
  const expenseSubMonthly = {};      // "cat||sub" -> [12] positive
  Object.entries(resolved.expenses).forEach(([catName, subs])=>{
    const catArr = new Array(12).fill(0);
    Object.entries(subs).forEach(([subName, subData])=>{
      const posArr = subData.monthly.map(v=>-v);
      expenseSubMonthly[catName+'||'+subName] = posArr;
      posArr.forEach((v,i)=>catArr[i]+=v);
    });
    expenseCategoryMonthly[catName] = catArr.map(v=>Math.round(v*100)/100);
  });
  const expenseTotalMonthly = new Array(12).fill(0);
  Object.values(expenseCategoryMonthly).forEach(arr=>arr.forEach((v,i)=>expenseTotalMonthly[i]+=v));

  const incomeSubMonthly = {}; // subName -> [12] positive (already positive)
  Object.entries(resolved.income).forEach(([subName, subData])=>{
    incomeSubMonthly[subName] = subData.monthly.slice();
  });
  const incomeTotalMonthly = new Array(12).fill(0);
  Object.values(incomeSubMonthly).forEach(arr=>arr.forEach((v,i)=>incomeTotalMonthly[i]+=v));

  return {
    expenseCategoryMonthly, expenseSubMonthly, expenseTotalMonthly,
    incomeSubMonthly, incomeTotalMonthly,
  };
}

function emptyBudgets(){ return { Expenses: {}, Income: {} }; }

/* ============================================================
   STATE
   ============================================================ */
let DATA = emptyData();
let BUDGETS_RAW = emptyBudgets();
let BUDGETS = resolveBudgets(BUDGETS_RAW, DATA.year);
let ROLL = buildBudgetRollups(BUDGETS, DATA.categories, DATA.incomeSubcats);

let timeframe = 'year';      // 'year' | 0-11 (month index)
let pill = 'ytd';            // 'ytd' | 'projection' | 'plan'  (Year view only)
let activeTab = 'expenses';  // 'income' | 'expenses'
let openCats = new Set();
let selectedSub = null;      // { kind:'expense', category, subcategory } | { kind:'income', subcategory } | null
let searchQuery = '';
let txnSort = { key: 'date', dir: 1 };

/* ============================================================
   HELPERS
   ============================================================ */
// User-facing display settings. showDollarSign defaults to off; a future
// settings UI can flip this at runtime (and re-render) to turn it back on.
const SETTINGS = {
  showDollarSign: false,
};
const fmt = (n) => {
  const v = Math.round(n);
  if (v === 0) return '–';
  const s = Math.abs(v).toLocaleString('en-US');
  const currency = SETTINGS.showDollarSign ? '$' : '';
  return (v < 0 ? '-' + currency : currency) + s;
};
const fmtSigned = (n) => {
  const v = Math.round(n);
  if (v === 0) return '–';
  const s = Math.abs(v).toLocaleString('en-US');
  return (v < 0 ? '-' : '+') + s;
};
const signCls = (n) => n < 0 ? 'neg' : (n > 0 ? 'pos' : '');

function monthName(i){ return MONTHS[i]; }
function monthFullName(i){ return MONTHS_FULL[i]; }

function findCategory(name){ return DATA.categories.find(c=>c.name===name); }
function findSubcategory(catName, subName){
  const c = findCategory(catName);
  return c ? c.subcategories.find(s=>s.name===subName) : null;
}
function findIncomeSub(name){ return DATA.incomeSubcats.find(s=>s.name===name); }

/* ============================================================
   LEFT PANEL — timeframe list
   ============================================================ */
function annualPlanNet(){
  return ROLL.incomeTotalMonthly.reduce((a,b)=>a+b,0) - ROLL.expenseTotalMonthly.reduce((a,b)=>a+b,0);
}
function monthPlanNet(mi){
  return ROLL.incomeTotalMonthly[mi] - ROLL.expenseTotalMonthly[mi];
}

function renderLeftNav(){
  const wrap = document.getElementById('tfList');
  wrap.innerHTML = '';

  const yearNet = DATA.net.reduce((a,b)=>a+b,0);
  wrap.appendChild(tfItem('Year', yearNet, 'year'));

  for (let i=0;i<12;i++){
    const hasData = DATA.monthsPresent.includes(i);
    const val = hasData ? DATA.net[i] : monthPlanNet(i);
    wrap.appendChild(tfItem(monthName(i), val, i));
  }
}
function tfItem(label, value, key){
  const div = document.createElement('div');
  div.className = 'tf-item' + (timeframe===key ? ' active' : '');
  const cls = value>0?'pos':(value<0?'neg':'zero');
  div.innerHTML = `<span>${label}</span><span class="net ${cls}">${value===0?'–':fmtSigned(value)}</span>`;
  div.addEventListener('click', ()=>{
    timeframe = key;
    searchQuery = '';
    document.getElementById('searchInput').value = '';
    renderAll();
  });
  return div;
}

/* ============================================================
   MIDDLE PANEL
   ============================================================ */
// Wraps a wide element (e.g. a table) in its own horizontally-scrolling
// container, so it can overflow without dragging the panel's sticky
// header along with it (the header lives outside this wrapper).
function wrapScroll(el){
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  wrap.appendChild(el);
  return wrap;
}

function renderMid(){
  const mid = document.getElementById('midPanel');
  mid.innerHTML = '';

  if (searchQuery){
    mid.appendChild(renderSearchResultsTable());
    return;
  }

  const body = document.createElement('div');
  body.className = 'mid-body';

  if (timeframe === 'year'){
    mid.appendChild(renderPills());
    body.appendChild(renderCards());
    body.appendChild(wrapScroll(renderYearTable()));
  } else {
    const title = document.createElement('div');
    title.className = 'mid-title';
    title.textContent = monthFullName(timeframe);
    mid.appendChild(title);
    body.appendChild(renderCards());
    body.appendChild(wrapScroll(renderMonthTable()));
  }
  mid.appendChild(body);
}

function renderPills(){
  const wrap = document.createElement('div');
  wrap.className = 'pills';
  [['ytd','YTD'],['projection','Projection'],['plan','Plan']].forEach(([key,label])=>{
    const b = document.createElement('button');
    b.className = 'pill' + (pill===key?' active':'');
    b.textContent = label;
    b.addEventListener('click', ()=>{ pill = key; selectedSub = null; renderAll(); });
    wrap.appendChild(b);
  });
  return wrap;
}

/* ---- Blended (Projection) monthly value for a subcategory ---- */
function projectedMonthly(actualMonthly, budgetMonthly){
  const cmi = DATA.currentMonthIndex;
  const out = new Array(12).fill(0);
  for (let i=0;i<12;i++){
    if (cmi === null){ out[i] = budgetMonthly[i]; continue; }
    if (i < cmi) out[i] = actualMonthly[i];
    else if (i === cmi) out[i] = Math.abs(actualMonthly[i]) > Math.abs(budgetMonthly[i]) ? actualMonthly[i] : budgetMonthly[i];
    else out[i] = budgetMonthly[i];
  }
  return out;
}

/* ---- Cards ---- */
function renderCards(){
  const wrap = document.createElement('div');
  wrap.className = 'cards';

  let incomeActual, expensesActual;
  if (timeframe === 'year'){
    if (pill === 'ytd'){
      incomeActual = DATA.monthsPresent.reduce((a,i)=>a+DATA.income[i],0);
      expensesActual = DATA.monthsPresent.reduce((a,i)=>a+DATA.expenses[i],0);
    } else if (pill === 'plan'){
      incomeActual = ROLL.incomeTotalMonthly.reduce((a,b)=>a+b,0);
      expensesActual = ROLL.expenseTotalMonthly.reduce((a,b)=>a+b,0);
    } else { // projection
      incomeActual = projectedMonthly(DATA.income, ROLL.incomeTotalMonthly).reduce((a,b)=>a+b,0);
      expensesActual = projectedMonthly(DATA.expenses, ROLL.expenseTotalMonthly).reduce((a,b)=>a+b,0);
    }
  } else {
    incomeActual = DATA.income[timeframe] || 0;
    expensesActual = DATA.expenses[timeframe] || 0;
  }
  const netActual = incomeActual - expensesActual;

  const incomePlan = timeframe==='year' ? ROLL.incomeTotalMonthly.reduce((a,b)=>a+b,0) : ROLL.incomeTotalMonthly[timeframe];
  const expensesPlan = timeframe==='year' ? ROLL.expenseTotalMonthly.reduce((a,b)=>a+b,0) : ROLL.expenseTotalMonthly[timeframe];
  const netPlan = incomePlan - expensesPlan;

  wrap.appendChild(card('Income', incomeActual, incomePlan, 'income', false));
  wrap.appendChild(card('Expenses', expensesActual, expensesPlan, 'expenses', false));
  wrap.appendChild(card('Net', netActual, netPlan, null, true));

  return wrap;
}
function card(label, actual, plan, tabKey, colorBySign){
  const div = document.createElement('div');
  div.className = 'card' + (tabKey ? ' tab' : '') + (tabKey && activeTab===tabKey ? ' active' : '');
  const valCls = colorBySign ? ('card-value num '+signCls(actual)) : 'card-value num';
  const valText = colorBySign ? fmtSigned(actual) : fmt(actual);
  const planText = colorBySign ? fmtSigned(plan) : fmt(plan);
  div.innerHTML = `
    <div class="card-head"><span class="card-label">${label}</span></div>
    <div class="${valCls}">${valText}</div>
    <div class="card-sub"><span>Plan</span><span class="amt num">${planText}</span></div>
  `;
  if (tabKey){
    div.addEventListener('click', ()=>{ activeTab = tabKey; selectedSub = null; renderAll(); });
  }
  return div;
}

/* ---- Year table ---- */
function renderYearTable(){
  const table = document.createElement('table');
  table.className = 'ledger';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Category</th>${MONTHS.map(m=>`<th>${m}</th>`).join('')}<th>Total</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  if (activeTab === 'expenses'){
    if (DATA.categories.length === 0){
      tbody.innerHTML = `<tr><td colspan="14" class="empty-table">No expense categories loaded yet.</td></tr>`;
    } else {
      let grandTotal = 0;
      const monthTotals = new Array(12).fill(0);
      DATA.categories.forEach(cat=>{
        const { values, dashMask } = yearRowValues(cat.monthly, ROLL.expenseCategoryMonthly[cat.name] || new Array(12).fill(0));
        values.forEach((v,i)=>monthTotals[i]+=v);
        const total = values.reduce((a,b)=>a+b,0);
        grandTotal += total;
        const isOpen = openCats.has(cat.name);
        const tr = document.createElement('tr');
        tr.className = 'cat-row';
        tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
          values.map((v,i)=>`<td class="num">${dashMask[i]?'<span class="dash">–</span>':fmt(v)}</td>`).join('') +
          `<td class="num">${fmt(total)}</td>`;
        tr.addEventListener('click', ()=>{
          if (openCats.has(cat.name)) openCats.delete(cat.name); else openCats.add(cat.name);
          renderMid();
        });
        tbody.appendChild(tr);

        cat.subcategories.forEach(sub=>{
          const subBudget = ROLL.expenseSubMonthly[cat.name+'||'+sub.name] || new Array(12).fill(0);
          const { values: subVals, dashMask: subDash } = yearRowValues(sub.monthly, subBudget);
          const subTotal = subVals.reduce((a,b)=>a+b,0);
          const isSel = selectedSub && selectedSub.kind==='expense' && selectedSub.category===cat.name && selectedSub.subcategory===sub.name;
          const sr = document.createElement('tr');
          sr.className = 'sub-row' + (isOpen?' open':'') + (isSel?' selected':'');
          sr.innerHTML = `<td><span class="cell-label">${sub.name}</span></td>` +
            subVals.map((v,i)=>`<td class="num">${subDash[i]?'<span class="dash">–</span>':fmt(v)}</td>`).join('') +
            `<td class="num">${fmt(subTotal)}</td>`;
          sr.addEventListener('click', (e)=>{
            e.stopPropagation();
            selectSub({ kind:'expense', category: cat.name, subcategory: sub.name });
          });
          tbody.appendChild(sr);
        });
      });
      const trTotal = document.createElement('tr');
      trTotal.className = 'total-row';
      trTotal.innerHTML = `<td>Total</td>` + monthTotals.map(v=>`<td class="num">${fmt(v)}</td>`).join('') + `<td class="num">${fmt(grandTotal)}</td>`;
      tbody.appendChild(trTotal);
    }
  } else {
    // Income — flat, selectable rows
    if (DATA.incomeSubcats.length === 0){
      tbody.innerHTML = `<tr><td colspan="14" class="empty-table">No income categories loaded yet.</td></tr>`;
    } else {
      let grandTotal = 0;
      const monthTotals = new Array(12).fill(0);
      DATA.incomeSubcats.forEach(sub=>{
        const budget = ROLL.incomeSubMonthly[sub.name] || new Array(12).fill(0);
        const { values, dashMask } = yearRowValues(sub.monthly, budget);
        values.forEach((v,i)=>monthTotals[i]+=v);
        const total = values.reduce((a,b)=>a+b,0);
        grandTotal += total;
        const isSel = selectedSub && selectedSub.kind==='income' && selectedSub.subcategory===sub.name;
        const tr = document.createElement('tr');
        tr.className = 'income-row' + (isSel?' selected':'');
        tr.innerHTML = `<td><span class="cell-label">${sub.name}</span></td>` +
          values.map((v,i)=>`<td class="num">${dashMask[i]?'<span class="dash">–</span>':fmt(v)}</td>`).join('') +
          `<td class="num">${fmt(total)}</td>`;
        tr.addEventListener('click', ()=>{
          selectSub({ kind:'income', subcategory: sub.name });
        });
        tbody.appendChild(tr);
      });
      const trTotal = document.createElement('tr');
      trTotal.className = 'total-row';
      trTotal.innerHTML = `<td>Total</td>` + monthTotals.map(v=>`<td class="num">${fmt(v)}</td>`).join('') + `<td class="num">${fmt(grandTotal)}</td>`;
      tbody.appendChild(trTotal);
    }
  }

  return table;
}

// Resolves the 12 display values + a dash-mask for a row, based on the active pill.
function yearRowValues(actualMonthly, budgetMonthly){
  if (pill === 'plan'){
    return { values: budgetMonthly, dashMask: new Array(12).fill(false) };
  }
  if (pill === 'projection'){
    return { values: projectedMonthly(actualMonthly, budgetMonthly), dashMask: new Array(12).fill(false) };
  }
  // ytd
  const values = actualMonthly.slice();
  const dashMask = new Array(12).fill(false).map((_,i)=>!DATA.monthsPresent.includes(i));
  return { values, dashMask };
}

/* ---- Month table (Plan / Actual / Difference) ---- */
function renderMonthTable(){
  const mi = timeframe;
  const table = document.createElement('table');
  table.className = 'ledger';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Category</th><th>Plan</th><th>Actual</th><th>Difference</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  function rowHTML(name, actual, planVal, indent){
    const diff = actual - planVal;
    return `<td${indent?' style="padding-left:30px"':''}><span class="cell-label">${name}</span></td>` +
      `<td class="num">${fmt(planVal)}</td>` +
      `<td class="num">${fmt(actual)}</td>` +
      `<td class="num">${diff===0?'<span class="dash">–</span>':fmtSigned(diff)}</td>`;
  }

  if (activeTab === 'expenses'){
    if (DATA.categories.length === 0){
      tbody.innerHTML = `<tr><td colspan="4" class="empty-table">No expense categories loaded yet.</td></tr>`;
    } else {
      let totActual=0, totPlan=0;
      DATA.categories.forEach(cat=>{
        const actual = cat.monthly[mi] || 0;
        const planVal = (ROLL.expenseCategoryMonthly[cat.name]||[])[mi] || 0;
        totActual += actual; totPlan += planVal;
        const isOpen = openCats.has(cat.name);
        const tr = document.createElement('tr');
        tr.className = 'cat-row';
        tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
          `<td class="num">${fmt(planVal)}</td><td class="num">${fmt(actual)}</td><td class="num">${fmtSigned(actual-planVal)}</td>`;
        tr.addEventListener('click', ()=>{
          if (openCats.has(cat.name)) openCats.delete(cat.name); else openCats.add(cat.name);
          renderMid();
        });
        tbody.appendChild(tr);

        cat.subcategories.forEach(sub=>{
          const subActual = sub.monthly[mi] || 0;
          const subPlan = (ROLL.expenseSubMonthly[cat.name+'||'+sub.name]||[])[mi] || 0;
          const isSel = selectedSub && selectedSub.kind==='expense' && selectedSub.category===cat.name && selectedSub.subcategory===sub.name;
          const sr = document.createElement('tr');
          sr.className = 'sub-row' + (isOpen?' open':'') + (isSel?' selected':'');
          sr.innerHTML = rowHTML(sub.name, subActual, subPlan, true);
          sr.addEventListener('click', (e)=>{
            e.stopPropagation();
            selectSub({ kind:'expense', category: cat.name, subcategory: sub.name });
          });
          tbody.appendChild(sr);
        });
      });
      const trTotal = document.createElement('tr');
      trTotal.className = 'total-row';
      trTotal.innerHTML = `<td>Total</td><td class="num">${fmt(totPlan)}</td><td class="num">${fmt(totActual)}</td><td class="num">${fmtSigned(totActual-totPlan)}</td>`;
      tbody.appendChild(trTotal);
    }
  } else {
    if (DATA.incomeSubcats.length === 0){
      tbody.innerHTML = `<tr><td colspan="4" class="empty-table">No income categories loaded yet.</td></tr>`;
    } else {
      let totActual=0, totPlan=0;
      DATA.incomeSubcats.forEach(sub=>{
        const actual = sub.monthly[mi] || 0;
        const planVal = (ROLL.incomeSubMonthly[sub.name]||[])[mi] || 0;
        totActual += actual; totPlan += planVal;
        const isSel = selectedSub && selectedSub.kind==='income' && selectedSub.subcategory===sub.name;
        const tr = document.createElement('tr');
        tr.className = 'income-row' + (isSel?' selected':'');
        tr.innerHTML = rowHTML(sub.name, actual, planVal, false);
        tr.addEventListener('click', ()=>{
          selectSub({ kind:'income', subcategory: sub.name });
        });
        tbody.appendChild(tr);
      });
      const trTotal = document.createElement('tr');
      trTotal.className = 'total-row';
      trTotal.innerHTML = `<td>Total</td><td class="num">${fmt(totPlan)}</td><td class="num">${fmt(totActual)}</td><td class="num">${fmtSigned(totActual-totPlan)}</td>`;
      tbody.appendChild(trTotal);
    }
  }

  return table;
}

/* ---- Search results (flat, all transactions) ---- */
function renderSearchResultsTable(){
  const wrap = document.createElement('div');
  wrap.className = 'mid-body';
  const heading = document.createElement('div');
  heading.className = 'search-heading';
  const rows = filteredSearchTxns();
  heading.innerHTML = `<b>${rows.length}</b> transaction${rows.length===1?'':'s'} matching "<b>${escapeHTML(searchQuery)}</b>"`;
  wrap.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'ledger txn-flat';
  const cols = [['date','Date'],['description','Description'],['amount','Amount'],['category','Category'],['subcategory','Subcategory'],['account','Account'],['type','Type']];
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${cols.map(([k,l])=>`<th data-key="${k}">${l}${txnSort.key===k?(txnSort.dir===1?' ▲':' ▼'):''}</th>`).join('')}</tr>`;
  thead.querySelectorAll('th').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.key;
      if (txnSort.key===key) txnSort.dir*=-1; else txnSort = { key, dir:1 };
      renderMid();
    });
  });
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  if (rows.length===0){
    tbody.innerHTML = `<tr><td colspan="7" class="empty-table">No transactions match.</td></tr>`;
  } else {
    rows.forEach(t=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="num">${t.date}</td><td>${escapeHTML(t.description)}</td>` +
        `<td class="num" style="color:${t.amount<0?'var(--negative)':'var(--positive)'}">${fmt(t.amount)}</td>` +
        `<td>${escapeHTML(t.category)}</td><td>${escapeHTML(t.subcategory)}</td><td>${escapeHTML(t.account)}</td><td>${escapeHTML(t.type)}</td>`;
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrap.appendChild(wrapScroll(table));
  return wrap;
}
function filteredSearchTxns(){
  const q = searchQuery.toLowerCase();
  let rows = DATA.transactions.filter(t =>
    (t.description+' '+t.category+' '+t.subcategory+' '+t.account+' '+t.type).toLowerCase().includes(q)
  );
  const { key, dir } = txnSort;
  rows = rows.slice().sort((a,b)=>{
    let av=a[key], bv=b[key];
    if (typeof av === 'string'){ av=av.toLowerCase(); bv=bv.toLowerCase(); }
    if (av<bv) return -1*dir;
    if (av>bv) return 1*dir;
    return 0;
  });
  return rows;
}
function escapeHTML(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function selectSub(sub){
  if (selectedSub && sub.kind===selectedSub.kind && sub.subcategory===selectedSub.subcategory &&
      sub.category===selectedSub.category){
    selectedSub = null; // toggle off
  } else {
    selectedSub = sub;
  }
  renderMid();
  renderRight();
}

/* ============================================================
   RIGHT PANEL
   ============================================================ */
function renderRight(){
  const right = document.getElementById('rightPanel');
  right.innerHTML = '';

  if (searchQuery){
    right.innerHTML = `<div class="right-body"><div class="right-empty">Search results are shown in the main panel. Clear the search to browse categories and see detail here.</div></div>`;
    return;
  }
  if (!selectedSub){
    right.innerHTML = `<div class="right-body"><div class="right-empty">Select a subcategory to see its ${timeframe==='year' ? (pill==='plan'?'planned line items':'transactions') : 'transactions'} here.</div></div>`;
    return;
  }

  const subName = selectedSub.subcategory;
  const headerEl = document.createElement('div');
  headerEl.className = 'right-header';
  const eyebrowEl = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'right-title';
  titleEl.textContent = subName;
  headerEl.appendChild(eyebrowEl);
  headerEl.appendChild(titleEl);
  right.appendChild(headerEl);

  const body = document.createElement('div');
  body.className = 'right-body';
  right.appendChild(body);

  if (timeframe !== 'year'){
    eyebrowEl.className = 'right-eyebrow';
    eyebrowEl.textContent = `${monthFullName(timeframe)} Transactions`;
    renderRightActualList(body, timeframe, timeframe);
    return;
  }

  eyebrowEl.className = 'right-eyebrow';
  eyebrowEl.textContent = pill==='plan' ? 'Planned Transactions' : (pill==='projection' ? 'Projected Transactions' : 'YTD Transactions');

  if (pill === 'ytd'){
    renderRightActualList(body, null, null);
  } else if (pill === 'plan'){
    renderRightPlannedList(body, null, null);
  } else {
    renderRightProjectedList(body);
  }
}

function getSelectedActualMonthly(){
  if (selectedSub.kind === 'expense') return findSubcategory(selectedSub.category, selectedSub.subcategory)?.monthly || new Array(12).fill(0);
  return findIncomeSub(selectedSub.subcategory)?.monthly || new Array(12).fill(0);
}
function getSelectedBudgetItems(){
  if (selectedSub.kind === 'expense'){
    const sub = (BUDGETS.expenses[selectedSub.category]||{})[selectedSub.subcategory];
    return sub ? sub.items : [];
  }
  const sub = BUDGETS.income[selectedSub.subcategory];
  return sub ? sub.items : [];
}
function getSelectedTxns(monthFilter){
  return DATA.transactions.filter(t=>{
    if (selectedSub.kind==='expense'){
      if (t.type!=='Expenses' || t.category!==selectedSub.category || t.subcategory!==selectedSub.subcategory) return false;
    } else {
      if (t.type!=='Income' || t.subcategory!==selectedSub.subcategory) return false;
    }
    if (monthFilter!==null && monthFilter!==undefined && t.month!==monthFilter) return false;
    return true;
  }).sort((a,b)=> a.date < b.date ? -1 : (a.date>b.date?1:0));
}

function renderRightTxnTable(container, rows){
  const total = rows.reduce((a,r)=>a+r.amount,0);
  const totalRow = document.createElement('div');
  totalRow.className = 'right-total-row';
  totalRow.innerHTML = `<span class="right-total-label">Total</span><span class="right-total-value num ${signCls(total)}">${fmt(total)}</span>`;
  container.appendChild(totalRow);

  const table = document.createElement('table');
  table.className = 'txn-list';
  table.innerHTML = `<thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  if (rows.length===0){
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-muted);padding:14px 0;">No transactions.</td></tr>`;
  } else {
    rows.forEach(r=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="txn-date">${r.dateLabel}</td><td>${escapeHTML(r.description)}</td><td class="amt ${signCls(r.amount)}">${fmt(r.amount)}</td>`;
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  container.appendChild(wrapScroll(table));
}

function renderRightActualList(container, monthFilter, forMonthLabel){
  const txns = getSelectedTxns(monthFilter).map(t=>({
    dateLabel: forMonthLabel!==null ? String(parseInt(t.date.slice(8,10),10)+'/'+parseInt(t.date.slice(5,7),10)) : (parseInt(t.date.slice(5,7),10))+'/'+(parseInt(t.date.slice(8,10),10)),
    description: t.description,
    amount: t.amount,
  }));
  renderRightTxnTable(container, txns);
}

function renderRightPlannedList(container, monthFilter){
  const items = getSelectedBudgetItems();
  const rows = [];
  for (let m=0;m<12;m++){
    if (monthFilter!==null && monthFilter!==undefined && m!==monthFilter) continue;
    items.forEach(it=>{
      const v = it.monthly[m];
      if (v){
        rows.push({ dateLabel: MONTHS[m], description: it.label, amount: v, _m:m });
      }
    });
  }
  renderRightTxnTable(container, rows);
}

function renderRightProjectedList(container){
  const cmi = DATA.currentMonthIndex;
  const actualMonthly = getSelectedActualMonthly();
  const items = getSelectedBudgetItems();
  const budgetMonthly = new Array(12).fill(0);
  items.forEach(it=>it.monthly.forEach((v,i)=>budgetMonthly[i]+=v));
  // Note: for expenses, actualMonthly is a positive magnitude while budgetMonthly
  // (raw item amounts) is negative — compare on absolute value, as in the table.
  const rows = [];
  for (let m=0;m<12;m++){
    let useActual;
    if (cmi === null) useActual = false;
    else if (m < cmi) useActual = true;
    else if (m === cmi) useActual = Math.abs(actualMonthly[m]) > Math.abs(budgetMonthly[m]);
    else useActual = false;

    if (useActual){
      getSelectedTxns(m).forEach(t=>{
        rows.push({ dateLabel: (parseInt(t.date.slice(5,7),10))+'/'+(parseInt(t.date.slice(8,10),10)), description: t.description, amount: t.amount });
      });
    } else {
      items.forEach(it=>{
        const v = it.monthly[m];
        if (v) rows.push({ dateLabel: MONTHS[m], description: it.label, amount: v });
      });
    }
  }
  renderRightTxnTable(container, rows);
}

/* ============================================================
   SEARCH INPUT
   ============================================================ */
document.getElementById('searchInput').addEventListener('input', (e)=>{
  searchQuery = e.target.value.trim();
  selectedSub = null;
  renderMid();
  renderRight();
});

/* ============================================================
   DATA LOADING (CSV + budgets JSON)
   ============================================================ */
function setIOStatus(msg, kind){
  const el = document.getElementById('ioStatus');
  el.textContent = msg;
  el.className = 'io-status' + (kind?' '+kind:'');
}

function recomputeDerived(){
  BUDGETS = resolveBudgets(BUDGETS_RAW, DATA.year);
  ROLL = buildBudgetRollups(BUDGETS, DATA.categories, DATA.incomeSubcats);
}

function loadFromCSVs(files){
  try{
    const allRows = [];
    files.forEach(f => allRows.push(...parseFidelityCSV(f.text, f.name)));
    if (allRows.length === 0) throw new Error('No transaction rows found in the file(s) provided.');
    DATA = aggregate(allRows, files.map(f=>f.name));
    recomputeDerived();
    setIOStatus(`Loaded ${DATA.transactions.length} transactions from ${files.map(f=>f.name).join(', ')}.`, 'ok');
    renderAll();
  } catch(err){
    setIOStatus('Could not parse CSV: ' + err.message, 'err');
  }
}
document.getElementById('csvPicker').addEventListener('change', async (e)=>{
  const fileList = Array.from(e.target.files || []);
  if (!fileList.length) return;
  const files = await Promise.all(fileList.map(f => f.text().then(text=>({name:f.name, text}))));
  loadFromCSVs(files);
});

document.getElementById('budgetPicker').addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try{
    const text = await file.text();
    const obj = JSON.parse(text);
    BUDGETS_RAW = { Expenses: obj.Expenses || {}, Income: obj.Income || {} };
    recomputeDerived();
    setIOStatus(`Budgets loaded from ${file.name}.`, 'ok');
    renderAll();
  } catch(err){
    setIOStatus('Could not read budgets file: ' + err.message, 'err');
  }
});

document.getElementById('downloadBudgets').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(BUDGETS_RAW, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'budgets.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

async function tryAutoFetch(){
  try{
    const res = await fetch('transactions.csv');
    if (res.ok){
      const text = await res.text();
      loadFromCSVs([{name:'transactions.csv', text}]);
    }
  } catch(e){ /* expected under file:// */ }
  try{
    const res = await fetch('budgets.json');
    if (res.ok){
      const obj = await res.json();
      BUDGETS_RAW = { Expenses: obj.Expenses || {}, Income: obj.Income || {} };
      recomputeDerived();
      renderAll();
    }
  } catch(e){ /* expected under file:// */ }
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */
function renderAll(){
  renderLeftNav();
  renderMid();
  renderRight();
}
renderAll();
tryAutoFetch();

/* ============================================================
   SCROLLBAR AUTO-HIDE
   Panels keep their scrollbar hidden at rest and only reveal it
   while actively being scrolled (see .scrolling in styles.css).
   ============================================================ */
(function initScrollbarAutoHide(){
  const HIDE_DELAY_MS = 600;
  const hideTimers = new WeakMap();
  // Delegated on document (capture phase) rather than attached to each
  // .panel/.table-scroll directly: 'scroll' doesn't bubble, but a capture
  // listener still sees it on its way down, and this way it also covers
  // .table-scroll wrappers, which are recreated on every render.
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || !el.matches('.panel, .table-scroll')) return;
    el.classList.add('scrolling');
    clearTimeout(hideTimers.get(el));
    hideTimers.set(el, setTimeout(() => el.classList.remove('scrolling'), HIDE_DELAY_MS));
  }, {passive:true, capture:true});
})();
