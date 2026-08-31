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

  // Income tree — top level keyed on CSV "Subcategory" (Income's Category
  // is always "Income", so Subcategory is the row grouping), same shape as
  // the expense category/subcategory tree below: each top-level row's
  // children are transactions rolled up by identical description, so
  // repeat income (e.g. the same employer's paycheck) collapses into one
  // selectable row instead of one per transaction.
  const incomeMap = new Map();
  rows.filter(r=>r.type==='Income').forEach(r=>{
    const mi = r.date.getMonth();
    const name = r.subcategory || '(Uncategorized)';
    if (!incomeMap.has(name)) incomeMap.set(name, new Map());
    const descMap = incomeMap.get(name);
    const desc = r.description || '(No description)';
    if (!descMap.has(desc)) descMap.set(desc, new Array(12).fill(0));
    descMap.get(desc)[mi] += r.amount;
  });
  const incomeSubcats = [...incomeMap.entries()].map(([name, descMap])=>{
    const subcategories = [...descMap.entries()].map(([dname, monthly])=>({
      name: dname,
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
  // Expenses and Income share the same Category -> Subcategory -> items
  // shape, so both groups resolve through the same logic.
  const resolveGroup = (groupRaw) => {
    const out = {};
    Object.entries(groupRaw||{}).forEach(([catName, subs])=>{
      out[catName] = {};
      Object.entries(subs||{}).forEach(([subName, items])=>{
        const list = Array.isArray(items) ? items : [];
        const resolvedItems = list.map(it=>({ freq: it.freq, label: it.label||subName, amount: it.amount, monthly: resolveLineItem(it, year) }));
        const monthly = new Array(12).fill(0);
        resolvedItems.forEach(it=>it.monthly.forEach((v,i)=>monthly[i]+=v));
        out[catName][subName] = { monthly: monthly.map(v=>Math.round(v*100)/100), items: resolvedItems };
      });
    });
    return out;
  };
  return {
    expenses: resolveGroup(raw && raw.Expenses),
    income: resolveGroup(raw && raw.Income),
  };
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

  // Income category (source) monthly = sum of its subcategories' (rolled-up
  // description) monthly — already positive, no sign flip needed. Same
  // bottom-up shape as expenses above.
  const incomeCategoryMonthly = {}; // catName -> [12] positive
  const incomeSubMonthly = {};      // "cat||sub" -> [12] positive
  Object.entries(resolved.income).forEach(([catName, subs])=>{
    const catArr = new Array(12).fill(0);
    Object.entries(subs).forEach(([subName, subData])=>{
      incomeSubMonthly[catName+'||'+subName] = subData.monthly.slice();
      subData.monthly.forEach((v,i)=>catArr[i]+=v);
    });
    incomeCategoryMonthly[catName] = catArr.map(v=>Math.round(v*100)/100);
  });
  const incomeTotalMonthly = new Array(12).fill(0);
  Object.values(incomeCategoryMonthly).forEach(arr=>arr.forEach((v,i)=>incomeTotalMonthly[i]+=v));

  return {
    expenseCategoryMonthly, expenseSubMonthly, expenseTotalMonthly,
    incomeCategoryMonthly, incomeSubMonthly, incomeTotalMonthly,
  };
}

function emptyBudgets(){ return { Expenses: {}, Income: {} }; }

/* ============================================================
   BUDGET EDITOR — converts the raw {Expenses,Income} JSON to/from an
   id-keyed working draft (so category/subcategory names can be freely
   renamed in text inputs without key-collision issues), plus the totals
   math shared by the editor's live per-row/category/right-panel numbers.
   ============================================================ */
let _budgetIdSeq = 1;
function nextBudgetId(){ return 'b' + (_budgetIdSeq++); }

function budgetsRawToDraft(raw){
  const toItems = (items, fallbackLabel) => (Array.isArray(items) ? items : []).map(it => ({
    id: nextBudgetId(),
    freq: it.freq || 'monthly',
    label: it.label != null ? it.label : fallbackLabel,
    amount: it.amount,
  }));
  // Expenses and Income share the same Category -> Subcategory -> items
  // shape, so both groups convert through the same logic.
  const toCategories = (groupRaw) => Object.entries(groupRaw || {}).map(([catName, subs]) => ({
    id: nextBudgetId(),
    name: catName,
    subcategories: Object.entries(subs || {}).map(([subName, items]) => ({
      id: nextBudgetId(),
      name: subName,
      items: toItems(items, subName),
    })),
  }));
  return {
    expenses: toCategories(raw && raw.Expenses),
    income: toCategories(raw && raw.Income),
  };
}

function draftToBudgetsRaw(draft){
  const serializeItems = (items) => items
    .filter(it => (it.label && it.label.trim()) || it.amount)
    .map(it => ({ freq: it.freq, label: it.label, amount: it.amount }));
  const serializeCategories = (list) => {
    const out = {};
    list.forEach(cat => {
      const catName = cat.name.trim();
      if (!catName) return;
      const subs = {};
      cat.subcategories.forEach(sub => {
        const subName = sub.name.trim();
        if (!subName) return;
        subs[subName] = serializeItems(sub.items);
      });
      out[catName] = subs;
    });
    return out;
  };
  return {
    Expenses: serializeCategories(draft.expenses),
    Income: serializeCategories(draft.income),
  };
}

// Sign convention matches the raw JSON: expense item amounts are stored
// negative (spend), income item amounts positive — same as everywhere
// else BUDGETS is consumed (see buildBudgetRollups above). The editor UI
// always displays/accepts positive numbers for expenses and flips the
// sign on read/write so users never have to think about it.
function budgetItemYearTotal(item){
  return resolveLineItem({ freq: item.freq, amount: item.amount }, DATA.year).reduce((a, b) => a + b, 0);
}
function budgetSubYearTotal(sub){
  return sub.items.reduce((a, it) => a + budgetItemYearTotal(it), 0);
}
function budgetCatYearTotal(cat){
  return cat.subcategories.reduce((a, s) => a + budgetSubYearTotal(s), 0);
}
function draftAnnualTotals(draft){
  const incomeTotal = draft.income.reduce((a, c) => a + budgetCatYearTotal(c), 0);
  const expenseTotal = draft.expenses.reduce((a, c) => a + Math.abs(budgetCatYearTotal(c)), 0);
  return { incomeTotal, expenseTotal, net: incomeTotal - expenseTotal };
}
function updateBudgetRightSummary(){
  if (!budgetSummaryEls) return;
  const t = draftAnnualTotals(budgetDraft);
  budgetSummaryEls.income.textContent = fmt(t.incomeTotal);
  budgetSummaryEls.expenses.textContent = fmt(t.expenseTotal);
  budgetSummaryEls.net.textContent = fmtSigned(t.net);
  budgetSummaryEls.net.className = 'right-total-value num ' + signCls(t.net);
}

function enterBudgetEditor(){
  budgetDraft = budgetsRawToDraft(BUDGETS_RAW);
  budgetEditMode = true;
  budgetEditTab = 'expenses';
  budgetOpenCats = new Set();
  searchQuery = '';
  document.getElementById('searchInput').value = '';
  document.getElementById('csvPicker').disabled = true;
  document.getElementById('budgetPicker').disabled = true;
  document.getElementById('editBudgetBtn').disabled = true;
  renderAll();
}
function exitBudgetEditor(){
  budgetEditMode = false;
  budgetDraft = null;
  budgetSummaryEls = null;
  document.getElementById('csvPicker').disabled = false;
  document.getElementById('budgetPicker').disabled = false;
  document.getElementById('editBudgetBtn').disabled = false;
}
function cancelBudgetEdit(){
  exitBudgetEditor();
  renderAll();
}
function saveBudgetEdit(){
  BUDGETS_RAW = draftToBudgetsRaw(budgetDraft);
  recomputeDerived();
  exitBudgetEditor();
  setIOStatus('Budget saved.', 'ok');
  renderAll();
}

// Pulls category/subcategory averages out of a prior year's transaction
// CSV(s) and adds them as suggested "last year avg" line items — additive
// only, so it never removes or overwrites anything already in the draft.
function importLastYearCSVIntoDraft(files){
  try{
    const allRows = [];
    files.forEach(f => allRows.push(...parseFidelityCSV(f.text, f.name)));
    if (allRows.length === 0) throw new Error('No transaction rows found in the file(s) provided.');
    const agg = aggregate(allRows, files.map(f => f.name));

    const hasExistingData = budgetDraft.expenses.length > 0 || budgetDraft.income.length > 0;
    if (hasExistingData && !confirm(
      "This budget already has categories. Importing will add a suggested line item (last year's monthly average) to matching or new subcategories — it won't remove or overwrite anything you've already entered. Continue?"
    )) return;

    const findByName = (list, name) => list.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase());

    agg.categories.forEach(cat => {
      let draftCat = findByName(budgetDraft.expenses, cat.name);
      if (!draftCat){
        draftCat = { id: nextBudgetId(), name: cat.name, subcategories: [] };
        budgetDraft.expenses.push(draftCat);
      }
      cat.subcategories.forEach(sub => {
        let draftSub = findByName(draftCat.subcategories, sub.name);
        if (!draftSub){
          draftSub = { id: nextBudgetId(), name: sub.name, items: [] };
          draftCat.subcategories.push(draftSub);
        }
        const avgMonthly = Math.round(sub.yearly / 12);
        if (avgMonthly !== 0){
          draftSub.items.push({ id: nextBudgetId(), freq: 'monthly', label: `${sub.name} (last year avg)`, amount: -avgMonthly });
        }
      });
      budgetOpenCats.add(draftCat.id);
    });

    agg.incomeSubcats.forEach(cat => {
      let draftCat = findByName(budgetDraft.income, cat.name);
      if (!draftCat){
        draftCat = { id: nextBudgetId(), name: cat.name, subcategories: [] };
        budgetDraft.income.push(draftCat);
      }
      cat.subcategories.forEach(sub => {
        let draftSub = findByName(draftCat.subcategories, sub.name);
        if (!draftSub){
          draftSub = { id: nextBudgetId(), name: sub.name, items: [] };
          draftCat.subcategories.push(draftSub);
        }
        const avgMonthly = Math.round(sub.yearly / 12);
        if (avgMonthly !== 0){
          draftSub.items.push({ id: nextBudgetId(), freq: 'monthly', label: `${sub.name} (last year avg)`, amount: avgMonthly });
        }
      });
      budgetOpenCats.add(draftCat.id);
    });

    setIOStatus(`Imported starting values from ${files.map(f => f.name).join(', ')}.`, 'ok');
    renderMid();
    renderRight();
  } catch(err){
    setIOStatus('Could not parse CSV: ' + err.message, 'err');
  }
}

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
let selectedSub = null;      // { kind:'expense'|'income', category, subcategory } | null — for income, category is the
                              // top-level income source and subcategory is a rolled-up transaction description
let searchQuery = '';
let txnSort = { key: 'date', dir: 1 };

// Budget editor — a distinct "mode" (like search) that takes over the mid
// and right panels. See the BUDGET EDITOR section below.
let budgetEditMode = false;
let budgetDraft = null;      // { expenses:[{id,name,subcategories:[{id,name,items:[{id,freq,label,amount}]}]}], income:[{id,name,items:[...]}] }
let budgetEditTab = 'expenses';  // 'expenses' | 'income', within the editor
let budgetOpenCats = new Set();  // open category ids, editor-local (separate from openCats)
let budgetFocusId = null;        // id of a newly-added row to focus after the next render
let budgetSummaryEls = null;     // right-panel live-total <span> refs while editing

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
function findIncomeCat(name){ return DATA.incomeSubcats.find(c=>c.name===name); }
function findIncomeSub(catName, subName){
  const c = findIncomeCat(catName);
  return c ? c.subcategories.find(s=>s.name===subName) : null;
}

// DATA.categories/incomeSubcats only contain rows seen in a loaded CSV — a
// category that only exists in the budget (e.g. set up before this year's
// transactions have been imported) wouldn't otherwise appear anywhere in
// the ledger table, only in the card totals. These merge in any
// budget-only category/subcategory as an all-zero-actual row, so a
// freshly-created budget is visible immediately, before any CSV is loaded.
function mergedExpenseCategories(){
  const result = DATA.categories.map(cat=>({
    name: cat.name,
    monthly: cat.monthly,
    subcategories: cat.subcategories.map(s=>({ name: s.name, monthly: s.monthly })),
  }));
  const byName = new Map(result.map(c=>[c.name, c]));
  Object.entries(BUDGETS.expenses||{}).forEach(([catName, subs])=>{
    let cat = byName.get(catName);
    if (!cat){
      cat = { name: catName, monthly: new Array(12).fill(0), subcategories: [] };
      byName.set(catName, cat);
      result.push(cat);
    }
    const subByName = new Map(cat.subcategories.map(s=>[s.name, s]));
    Object.keys(subs||{}).forEach(subName=>{
      if (!subByName.has(subName)){
        const sub = { name: subName, monthly: new Array(12).fill(0) };
        cat.subcategories.push(sub);
        subByName.set(subName, sub);
      }
    });
  });
  return result;
}
function mergedIncomeSubcats(){
  const result = DATA.incomeSubcats.map(cat=>({
    name: cat.name,
    monthly: cat.monthly,
    subcategories: cat.subcategories.map(s=>({ name: s.name, monthly: s.monthly })),
  }));
  const byName = new Map(result.map(c=>[c.name, c]));
  Object.entries(BUDGETS.income||{}).forEach(([catName, subs])=>{
    let cat = byName.get(catName);
    if (!cat){
      cat = { name: catName, monthly: new Array(12).fill(0), subcategories: [] };
      byName.set(catName, cat);
      result.push(cat);
    }
    const subByName = new Map(cat.subcategories.map(s=>[s.name, s]));
    Object.keys(subs||{}).forEach(subName=>{
      if (!subByName.has(subName)){
        const sub = { name: subName, monthly: new Array(12).fill(0) };
        cat.subcategories.push(sub);
        subByName.set(subName, sub);
      }
    });
  });
  return result;
}

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

  const cmi = DATA.currentMonthIndex;
  for (let i=0;i<12;i++){
    const hasData = DATA.monthsPresent.includes(i);
    const val = hasData ? DATA.net[i] : monthPlanNet(i);
    const isFuture = cmi === null ? true : i > cmi;
    wrap.appendChild(tfItem(monthName(i), val, i, isFuture));
  }
}
function tfItem(label, value, key, isFuture){
  const div = document.createElement('div');
  div.className = 'tf-item' + (timeframe===key ? ' active' : '') + (isFuture ? ' future' : '');
  const cls = value>0?'pos':(value<0?'neg':'zero');
  div.innerHTML = `<span class="tf-label">${label}</span><span class="net ${isFuture?'':cls}">${value===0?'–':fmtSigned(value)}</span>`;
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

  if (budgetEditMode){
    renderBudgetEditor(mid);
    if (budgetFocusId){
      const id = budgetFocusId;
      budgetFocusId = null;
      const el = mid.querySelector(
        `[data-cat-id="${id}"] > .budget-cat-header .budget-name-input, [data-sub-id="${id}"] > .budget-sub-header .budget-name-input`
      );
      if (el){ el.focus(); if (el.select) el.select(); }
    }
    return;
  }

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
    b.addEventListener('click', ()=>{ pill = key; renderAll(); });
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

  // On the YTD pill, "Plan" should read as "planned through the months
  // we actually have data for" — not the full year — so it's a fair
  // comparison against the actual value shown above it.
  const yearPlanSum = (monthly) => timeframe==='year' && pill==='ytd'
    ? DATA.monthsPresent.reduce((a,i)=>a+monthly[i],0)
    : monthly.reduce((a,b)=>a+b,0);
  const incomePlan = timeframe==='year' ? yearPlanSum(ROLL.incomeTotalMonthly) : ROLL.incomeTotalMonthly[timeframe];
  const expensesPlan = timeframe==='year' ? yearPlanSum(ROLL.expenseTotalMonthly) : ROLL.expenseTotalMonthly[timeframe];
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
    <div class="card-head"><span class="card-label">${label}</span><span class="${valCls}">${valText}</span></div>
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
  table.className = 'ledger ledger-year';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Category</th>${MONTHS.map(m=>`<th>${m}</th>`).join('')}<th>Total</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  const plannedMask = plannedMonthMask();
  const noDash = new Array(12).fill(false);
  const numCell = (v, i, dashMask) => `<td class="num${plannedMask[i]?' planned':''}">${dashMask[i]?'<span class="dash">–</span>':fmt(v)}</td>`;

  if (activeTab === 'expenses'){
    const categories = mergedExpenseCategories();
    if (categories.length === 0){
      tbody.innerHTML = `<tr><td colspan="14" class="empty-table">No expense categories loaded yet.</td></tr>`;
    } else {
      let grandTotal = 0;
      const monthTotals = new Array(12).fill(0);
      categories.forEach(cat=>{
        const { values, dashMask } = yearRowValues(cat.monthly, ROLL.expenseCategoryMonthly[cat.name] || new Array(12).fill(0));
        values.forEach((v,i)=>monthTotals[i]+=v);
        const total = values.reduce((a,b)=>a+b,0);
        grandTotal += total;
        const isOpen = openCats.has(cat.name);
        const hasSelectedSub = !isOpen && selectedSub && selectedSub.kind==='expense' && selectedSub.category===cat.name;
        const tr = document.createElement('tr');
        tr.className = 'cat-row' + (hasSelectedSub?' has-selection':'');
        tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
          values.map((v,i)=>numCell(v,i,dashMask)).join('') +
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
            subVals.map((v,i)=>numCell(v,i,subDash)).join('') +
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
      trTotal.innerHTML = `<td>Total</td>` + monthTotals.map((v,i)=>numCell(v,i,noDash)).join('') + `<td class="num">${fmt(grandTotal)}</td>`;
      tbody.appendChild(trTotal);
    }
  } else {
    // Income — top-level rows (income sources) expand to reveal
    // transactions rolled up by identical description; only those
    // description rows are selectable, same pattern as expenses.
    const incomeSubcats = mergedIncomeSubcats();
    if (incomeSubcats.length === 0){
      tbody.innerHTML = `<tr><td colspan="14" class="empty-table">No income categories loaded yet.</td></tr>`;
    } else {
      let grandTotal = 0;
      const monthTotals = new Array(12).fill(0);
      incomeSubcats.forEach(cat=>{
        const budget = ROLL.incomeCategoryMonthly[cat.name] || new Array(12).fill(0);
        const { values, dashMask } = yearRowValues(cat.monthly, budget);
        values.forEach((v,i)=>monthTotals[i]+=v);
        const total = values.reduce((a,b)=>a+b,0);
        grandTotal += total;
        const isOpen = openCats.has(cat.name);
        const hasSelectedSub = !isOpen && selectedSub && selectedSub.kind==='income' && selectedSub.category===cat.name;
        const tr = document.createElement('tr');
        tr.className = 'cat-row' + (hasSelectedSub?' has-selection':'');
        tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
          values.map((v,i)=>numCell(v,i,dashMask)).join('') +
          `<td class="num">${fmt(total)}</td>`;
        tr.addEventListener('click', ()=>{
          if (openCats.has(cat.name)) openCats.delete(cat.name); else openCats.add(cat.name);
          renderMid();
        });
        tbody.appendChild(tr);

        cat.subcategories.forEach(sub=>{
          const subBudget = ROLL.incomeSubMonthly[cat.name+'||'+sub.name] || new Array(12).fill(0);
          const { values: subVals, dashMask: subDash } = yearRowValues(sub.monthly, subBudget);
          const subTotal = subVals.reduce((a,b)=>a+b,0);
          const isSel = selectedSub && selectedSub.kind==='income' && selectedSub.category===cat.name && selectedSub.subcategory===sub.name;
          const sr = document.createElement('tr');
          sr.className = 'sub-row' + (isOpen?' open':'') + (isSel?' selected':'');
          sr.innerHTML = `<td><span class="cell-label">${sub.name}</span></td>` +
            subVals.map((v,i)=>numCell(v,i,subDash)).join('') +
            `<td class="num">${fmt(subTotal)}</td>`;
          sr.addEventListener('click', (e)=>{
            e.stopPropagation();
            selectSub({ kind:'income', category: cat.name, subcategory: sub.name });
          });
          tbody.appendChild(sr);
        });
      });
      const trTotal = document.createElement('tr');
      trTotal.className = 'total-row';
      trTotal.innerHTML = `<td>Total</td>` + monthTotals.map((v,i)=>numCell(v,i,noDash)).join('') + `<td class="num">${fmt(grandTotal)}</td>`;
      tbody.appendChild(trTotal);
    }
  }

  return table;
}

// Which of the 12 months are showing a planned (budget) rather than actual
// value for the current pill — Plan: always; Projection: any month after
// the current one (or every month, if there's no "current month" to speak
// of yet); YTD: never. Same for every row, so callers compute it once.
function plannedMonthMask(){
  if (pill === 'plan') return new Array(12).fill(true);
  if (pill === 'projection'){
    const cmi = DATA.currentMonthIndex;
    return new Array(12).fill(false).map((_,i)=> cmi===null ? true : i>cmi);
  }
  return new Array(12).fill(false);
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
  table.className = 'ledger ledger-month';
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
    const categories = mergedExpenseCategories();
    if (categories.length === 0){
      tbody.innerHTML = `<tr><td colspan="4" class="empty-table">No expense categories loaded yet.</td></tr>`;
    } else {
      let totActual=0, totPlan=0;
      categories.forEach(cat=>{
        const actual = cat.monthly[mi] || 0;
        const planVal = (ROLL.expenseCategoryMonthly[cat.name]||[])[mi] || 0;
        totActual += actual; totPlan += planVal;
        const isOpen = openCats.has(cat.name);
        const hasSelectedSub = !isOpen && selectedSub && selectedSub.kind==='expense' && selectedSub.category===cat.name;
        const tr = document.createElement('tr');
        tr.className = 'cat-row' + (hasSelectedSub?' has-selection':'');
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
    const incomeSubcats = mergedIncomeSubcats();
    if (incomeSubcats.length === 0){
      tbody.innerHTML = `<tr><td colspan="4" class="empty-table">No income categories loaded yet.</td></tr>`;
    } else {
      let totActual=0, totPlan=0;
      incomeSubcats.forEach(cat=>{
        const actual = cat.monthly[mi] || 0;
        const planVal = (ROLL.incomeCategoryMonthly[cat.name]||[])[mi] || 0;
        totActual += actual; totPlan += planVal;
        const isOpen = openCats.has(cat.name);
        const hasSelectedSub = !isOpen && selectedSub && selectedSub.kind==='income' && selectedSub.category===cat.name;
        const tr = document.createElement('tr');
        tr.className = 'cat-row' + (hasSelectedSub?' has-selection':'');
        tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
          `<td class="num">${fmt(planVal)}</td><td class="num">${fmt(actual)}</td><td class="num">${fmtSigned(actual-planVal)}</td>`;
        tr.addEventListener('click', ()=>{
          if (openCats.has(cat.name)) openCats.delete(cat.name); else openCats.add(cat.name);
          renderMid();
        });
        tbody.appendChild(tr);

        cat.subcategories.forEach(sub=>{
          const subActual = sub.monthly[mi] || 0;
          const subPlan = (ROLL.incomeSubMonthly[cat.name+'||'+sub.name]||[])[mi] || 0;
          const isSel = selectedSub && selectedSub.kind==='income' && selectedSub.category===cat.name && selectedSub.subcategory===sub.name;
          const sr = document.createElement('tr');
          sr.className = 'sub-row' + (isOpen?' open':'') + (isSel?' selected':'');
          sr.innerHTML = rowHTML(sub.name, subActual, subPlan, true);
          sr.addEventListener('click', (e)=>{
            e.stopPropagation();
            selectSub({ kind:'income', category: cat.name, subcategory: sub.name });
          });
          tbody.appendChild(sr);
        });
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
   BUDGET EDITOR — mid-panel UI. A distinct mode (like search): while
   active it fully replaces the mid/right panel content. Text/number
   field edits mutate budgetDraft in place and patch just the affected
   total <span>s (no full re-render, so focus/cursor position survives
   typing); structural changes (add/remove category, subcategory, or
   line item; expand/collapse) call renderMid() to rebuild from
   budgetDraft, since row DOM has to change shape anyway.
   ============================================================ */
function renderBudgetEditor(mid){
  const header = document.createElement('div');
  header.className = 'budget-editor-header';
  const hasSaved = Object.keys(BUDGETS_RAW.Expenses||{}).length || Object.keys(BUDGETS_RAW.Income||{}).length;
  header.innerHTML = `
    <div class="budget-editor-title">${hasSaved ? 'Edit Budget' : 'Create Budget'}</div>
    <div class="budget-editor-actions">
      <button class="file-btn ghost" type="button" id="budgetCancelBtn">Cancel</button>
      <button class="file-btn primary" type="button" id="budgetSaveBtn">Save budget</button>
    </div>
  `;
  header.querySelector('#budgetCancelBtn').addEventListener('click', ()=>{
    if (confirm('Discard changes to this budget?')) cancelBudgetEdit();
  });
  header.querySelector('#budgetSaveBtn').addEventListener('click', saveBudgetEdit);
  mid.appendChild(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'budget-editor-toolbar';
  const toggle = document.createElement('div');
  toggle.className = 'budget-tab-toggle';
  [['expenses','Expenses'],['income','Income']].forEach(([key,label])=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (budgetEditTab===key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', ()=>{ budgetEditTab = key; renderMid(); renderRight(); });
    toggle.appendChild(b);
  });
  toolbar.appendChild(toggle);

  const importLabel = document.createElement('label');
  importLabel.className = 'file-btn';
  importLabel.textContent = "Import last year's CSV as starting point";
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.csv';
  importInput.multiple = true;
  importLabel.appendChild(importInput);
  importInput.addEventListener('change', async (e)=>{
    const fileList = Array.from(e.target.files || []);
    if (!fileList.length) return;
    const files = await Promise.all(fileList.map(f => f.text().then(text=>({name:f.name, text}))));
    importLastYearCSVIntoDraft(files);
    e.target.value = '';
  });
  toolbar.appendChild(importLabel);
  mid.appendChild(toolbar);

  const body = document.createElement('div');
  body.className = 'budget-editor-body';
  if (budgetEditTab === 'expenses') renderBudgetExpensesBody(body);
  else renderBudgetIncomeBody(body);
  mid.appendChild(body);
}

function renderBudgetExpensesBody(container){
  if (budgetDraft.expenses.length === 0){
    const hint = document.createElement('div');
    hint.className = 'budget-empty-hint';
    hint.textContent = 'No expense categories yet. Click "+ Add category" below, or import last year’s CSV as a starting point.';
    container.appendChild(hint);
  }
  budgetDraft.expenses.forEach(cat=>{
    container.appendChild(renderBudgetCategoryBlock(cat, { kind:'expense' }));
  });
  const addCatBtn = document.createElement('button');
  addCatBtn.type = 'button';
  addCatBtn.className = 'add-cat-btn';
  addCatBtn.textContent = '+ Add category';
  addCatBtn.addEventListener('click', ()=>{
    const cat = { id: nextBudgetId(), name:'', subcategories: [] };
    budgetDraft.expenses.push(cat);
    budgetOpenCats.add(cat.id);
    budgetFocusId = cat.id;
    renderMid();
    renderRight();
  });
  container.appendChild(addCatBtn);
}

function renderBudgetIncomeBody(container){
  if (budgetDraft.income.length === 0){
    const hint = document.createElement('div');
    hint.className = 'budget-empty-hint';
    hint.textContent = 'No income sources yet. Click "+ Add income source" below, or import last year’s CSV as a starting point.';
    container.appendChild(hint);
  }
  budgetDraft.income.forEach(cat=>{
    container.appendChild(renderBudgetCategoryBlock(cat, { kind:'income' }));
  });
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-cat-btn';
  addBtn.textContent = '+ Add income source';
  addBtn.addEventListener('click', ()=>{
    const cat = { id: nextBudgetId(), name:'', subcategories: [] };
    budgetDraft.income.push(cat);
    budgetOpenCats.add(cat.id);
    budgetFocusId = cat.id;
    renderMid();
    renderRight();
  });
  container.appendChild(addBtn);
}

// opts: { kind: 'expense' | 'income' } — income sources and expense
// categories are both Category -> Subcategory -> line items now, so this
// one block (and renderBudgetSubBlock below) renders both, with only the
// wording and which budgetDraft array is written to differing by kind.
function renderBudgetCategoryBlock(cat, opts){
  const kind = opts.kind;
  const wrap = document.createElement('div');
  wrap.className = 'budget-cat';
  wrap.dataset.catId = cat.id;
  const isOpen = budgetOpenCats.has(cat.id);

  const header = document.createElement('div');
  header.className = 'budget-cat-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow' + (isOpen ? ' open' : '');
  arrow.innerHTML = `<img src="icons/chevron-right.svg" alt="">`;
  header.appendChild(arrow);

  const nameInput = document.createElement('input');
  nameInput.className = 'budget-name-input';
  nameInput.placeholder = kind==='income' ? 'Income source name' : 'Category name';
  nameInput.value = cat.name;
  nameInput.addEventListener('input', ()=>{ cat.name = nameInput.value; });
  nameInput.addEventListener('click', e=>e.stopPropagation());
  header.appendChild(nameInput);

  const totalEl = document.createElement('span');
  totalEl.className = 'budget-cat-total num';
  totalEl.textContent = fmt(Math.abs(budgetCatYearTotal(cat)));
  header.appendChild(totalEl);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-btn';
  removeBtn.title = kind==='income' ? 'Delete income source' : 'Delete category';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const label = kind==='income' ? 'income source' : 'category';
    if (!confirm(`Delete ${label} "${cat.name || '(unnamed)'}" and all its subcategories?`)) return;
    if (kind==='income') budgetDraft.income = budgetDraft.income.filter(c=>c.id!==cat.id);
    else budgetDraft.expenses = budgetDraft.expenses.filter(c=>c.id!==cat.id);
    renderMid();
    renderRight();
  });
  header.appendChild(removeBtn);

  header.addEventListener('click', ()=>{
    if (budgetOpenCats.has(cat.id)) budgetOpenCats.delete(cat.id); else budgetOpenCats.add(cat.id);
    renderMid();
  });
  wrap.appendChild(header);

  if (isOpen){
    const subsWrap = document.createElement('div');
    subsWrap.className = 'budget-subcats';
    cat.subcategories.forEach(sub=>{
      subsWrap.appendChild(renderBudgetSubBlock(sub, { kind, cat, catTotalEl: totalEl }));
    });
    const addSubBtn = document.createElement('button');
    addSubBtn.type = 'button';
    addSubBtn.className = 'add-sub-btn';
    addSubBtn.textContent = '+ Add subcategory';
    addSubBtn.addEventListener('click', ()=>{
      const sub = { id: nextBudgetId(), name:'', items: [] };
      cat.subcategories.push(sub);
      budgetFocusId = sub.id;
      renderMid();
      renderRight();
    });
    subsWrap.appendChild(addSubBtn);
    wrap.appendChild(subsWrap);
  }

  return wrap;
}

// opts: { kind: 'expense' | 'income', cat, catTotalEl }
function renderBudgetSubBlock(sub, opts){
  const wrap = document.createElement('div');
  wrap.className = 'budget-sub';
  wrap.dataset.subId = sub.id;

  const header = document.createElement('div');
  header.className = 'budget-sub-header';

  const nameInput = document.createElement('input');
  nameInput.className = 'budget-name-input';
  nameInput.placeholder = 'Subcategory name';
  nameInput.value = sub.name;
  nameInput.addEventListener('input', ()=>{ sub.name = nameInput.value; });
  header.appendChild(nameInput);

  const totalEl = document.createElement('span');
  totalEl.className = 'budget-sub-total num';
  totalEl.textContent = fmt(Math.abs(budgetSubYearTotal(sub)));
  header.appendChild(totalEl);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-btn';
  removeBtn.title = 'Delete';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', ()=>{
    if (!confirm(`Delete "${sub.name || '(unnamed)'}"?`)) return;
    opts.cat.subcategories = opts.cat.subcategories.filter(s=>s.id!==sub.id);
    renderMid();
    renderRight();
  });
  header.appendChild(removeBtn);
  wrap.appendChild(header);

  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'budget-items';
  sub.items.forEach(item=>{
    itemsWrap.appendChild(renderBudgetItemRow(item, sub, opts, totalEl));
  });
  wrap.appendChild(itemsWrap);

  const addItemBtn = document.createElement('button');
  addItemBtn.type = 'button';
  addItemBtn.className = 'add-item-btn';
  addItemBtn.textContent = '+ Add line item';
  addItemBtn.addEventListener('click', ()=>{
    sub.items.push({ id: nextBudgetId(), freq:'monthly', label: sub.name||'', amount: 0 });
    renderMid();
    renderRight();
  });
  wrap.appendChild(addItemBtn);

  return wrap;
}

function onBudgetItemChanged(sub, opts, subTotalEl){
  subTotalEl.textContent = fmt(Math.abs(budgetSubYearTotal(sub)));
  if (opts.catTotalEl){
    opts.catTotalEl.textContent = fmt(Math.abs(budgetCatYearTotal(opts.cat)));
  }
  updateBudgetRightSummary();
}

function renderBudgetItemRow(item, sub, opts, subTotalEl){
  const row = document.createElement('div');
  row.className = 'budget-item-row';

  const labelInput = document.createElement('input');
  labelInput.className = 'budget-item-label';
  labelInput.placeholder = 'Label';
  labelInput.value = item.label || '';
  labelInput.addEventListener('input', ()=>{ item.label = labelInput.value; });
  row.appendChild(labelInput);

  const freqSelect = document.createElement('select');
  freqSelect.className = 'budget-item-freq';
  const freqOptions = [['monthly','Monthly'],['daily','Daily'], ...MONTHS_FULL.map((m,i)=>[MONTH_ABBR[i], m+' (once)'])];
  const curFreq = (item.freq||'monthly').toLowerCase();
  freqOptions.forEach(([val,label])=>{
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (curFreq === val) opt.selected = true;
    freqSelect.appendChild(opt);
  });
  row.appendChild(freqSelect);

  const isArrayAmount = Array.isArray(item.amount) && curFreq === 'monthly';
  let amountInput = null;
  if (isArrayAmount){
    const note = document.createElement('span');
    note.className = 'budget-array-note';
    const avg = item.amount.reduce((a,b)=>a+(Number(b)||0),0)/12;
    note.textContent = `Custom monthly values (avg ${fmt(Math.abs(avg))})`;
    const convertBtn = document.createElement('button');
    convertBtn.type = 'button';
    convertBtn.className = 'icon-btn';
    convertBtn.title = 'Replace with a single amount';
    convertBtn.textContent = '✎';
    convertBtn.addEventListener('click', ()=>{
      item.amount = Math.round(Math.abs(avg));
      renderMid();
      renderRight();
    });
    note.appendChild(convertBtn);
    row.appendChild(note);
  } else {
    amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.step = '1';
    amountInput.className = 'budget-item-amount num';
    const displayVal = opts.kind==='expense' ? Math.abs(Number(item.amount)||0) : (Number(item.amount)||0);
    amountInput.value = displayVal || '';
    amountInput.placeholder = '0';
    row.appendChild(amountInput);
  }

  freqSelect.addEventListener('change', ()=>{
    item.freq = freqSelect.value;
    onBudgetItemChanged(sub, opts, subTotalEl);
  });
  if (amountInput){
    amountInput.addEventListener('input', ()=>{
      const raw = parseFloat(amountInput.value);
      const v = isNaN(raw) ? 0 : raw;
      item.amount = opts.kind==='expense' ? -Math.abs(v) : Math.abs(v);
      onBudgetItemChanged(sub, opts, subTotalEl);
    });
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-btn';
  removeBtn.title = 'Remove line item';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', ()=>{
    sub.items = sub.items.filter(it=>it.id!==item.id);
    renderMid();
    renderRight();
  });
  row.appendChild(removeBtn);

  return row;
}

/* ============================================================
   RIGHT PANEL
   ============================================================ */
function renderRight(){
  const right = document.getElementById('rightPanel');
  right.innerHTML = '';

  if (budgetEditMode){
    const t = draftAnnualTotals(budgetDraft);
    right.innerHTML = `
      <div class="right-header">
        <div class="right-eyebrow">Annual Plan Preview</div>
        <div class="right-title">${budgetEditTab==='expenses'?'Expenses':'Income'} draft</div>
      </div>
      <div class="right-body">
        <div class="right-total-row"><span class="right-total-label">Income</span><span class="right-total-value num" id="budgetSumIncome">${fmt(t.incomeTotal)}</span></div>
        <div class="right-total-row"><span class="right-total-label">Expenses</span><span class="right-total-value num" id="budgetSumExpenses">${fmt(t.expenseTotal)}</span></div>
        <div class="right-total-row"><span class="right-total-label">Net</span><span class="right-total-value num ${signCls(t.net)}" id="budgetSumNet">${fmtSigned(t.net)}</span></div>
        <div class="right-empty">Totals update as you edit. Nothing is saved until you click <b>Save budget</b>.</div>
      </div>
    `;
    budgetSummaryEls = {
      income: document.getElementById('budgetSumIncome'),
      expenses: document.getElementById('budgetSumExpenses'),
      net: document.getElementById('budgetSumNet'),
    };
    return;
  }

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
    renderRightActualList(body, timeframe);
    return;
  }

  eyebrowEl.className = 'right-eyebrow';
  eyebrowEl.textContent = pill==='plan' ? 'Planned Transactions' : (pill==='projection' ? 'Projected Transactions' : 'YTD Transactions');

  if (pill === 'ytd'){
    renderRightActualList(body, null);
  } else if (pill === 'plan'){
    renderRightPlannedList(body, null, null);
    renderAddToPlanControl(body);
  } else {
    renderRightProjectedList(body);
  }
}

function getSelectedActualMonthly(){
  if (selectedSub.kind === 'expense') return findSubcategory(selectedSub.category, selectedSub.subcategory)?.monthly || new Array(12).fill(0);
  return findIncomeSub(selectedSub.category, selectedSub.subcategory)?.monthly || new Array(12).fill(0);
}
function getSelectedBudgetItems(){
  const group = selectedSub.kind === 'expense' ? BUDGETS.expenses : BUDGETS.income;
  const sub = (group[selectedSub.category]||{})[selectedSub.subcategory];
  return sub ? sub.items : [];
}

// Adds a new raw budget line item for whatever is currently selected —
// same target the "Add to plan" quick-add control (Year tab, Plan pill)
// writes to. Expenses and income both live at Category -> Subcategory ->
// items, so both kinds are written the same way. Amount is entered by the
// user as a plain positive number; the stored sign follows the same
// convention as everywhere else BUDGETS_RAW is written (negative for
// expenses, positive for income).
function addSelectedBudgetItem(freq, label, rawAmount, target){
  const t = target || selectedSub;
  if (!t) return false;
  const amt = Math.abs(Number(rawAmount) || 0);
  if (amt === 0) return false;
  const item = {
    freq,
    label: (label && label.trim()) || t.subcategory,
    amount: t.kind==='expense' ? -amt : amt,
  };
  const group = t.kind === 'expense' ? BUDGETS_RAW.Expenses : BUDGETS_RAW.Income;
  if (!group[t.category]) group[t.category] = {};
  const subs = group[t.category];
  if (!subs[t.subcategory]) subs[t.subcategory] = [];
  subs[t.subcategory].push(item);
  recomputeDerived();
  return true;
}
function getSelectedTxns(monthFilter){
  return DATA.transactions.filter(t=>{
    if (selectedSub.kind==='expense'){
      if (t.type!=='Expenses' || t.category!==selectedSub.category || t.subcategory!==selectedSub.subcategory) return false;
    } else {
      if (t.type!=='Income' || t.subcategory!==selectedSub.category || t.description!==selectedSub.subcategory) return false;
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
      tr.className = r.planned ? 'planned' : '';
      tr.innerHTML = `<td class="txn-date">${r.dateLabel}</td><td>${escapeHTML(r.description)}</td><td class="amt ${r.planned?'':signCls(r.amount)}">${fmt(r.amount)}</td>`;
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  container.appendChild(wrapScroll(table));
}

function renderRightActualList(container, monthFilter){
  const txns = getSelectedTxns(monthFilter).map(t=>({
    dateLabel: (parseInt(t.date.slice(5,7),10))+'/'+(parseInt(t.date.slice(8,10),10)),
    description: t.description,
    amount: t.amount,
    planned: false,
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
        rows.push({ dateLabel: MONTHS[m], description: it.label, amount: v, _m:m, planned: true });
      }
    });
  }
  renderRightTxnTable(container, rows);
}

// Quick-add control shown under the planned line items (Year tab, Plan
// pill, row selected) — lets the user add a one-time or monthly recurring
// budget line item for whatever's selected without opening the full
// budget editor. Writes straight to BUDGETS_RAW via addSelectedBudgetItem.
function renderAddToPlanControl(container){
  const wrap = document.createElement('div');
  wrap.className = 'add-plan-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'add-item-btn';
  btn.textContent = '+ Add to plan';
  btn.addEventListener('click', openAddToPlanModal);
  wrap.appendChild(btn);

  container.appendChild(wrap);
}

// Centered modal (with a scrim behind it) for the "Add to plan" quick-add
// form — built fresh and appended to <body> each time it opens, so it
// overlays the whole app rather than being scoped to the right panel.
function openAddToPlanModal(){
  if (!selectedSub) return;
  const kind = selectedSub.kind;
  // Expenses and income both live at Category -> Subcategory -> items, so
  // both kinds show the same category + subcategory pair of selectors below.
  const mergedCatsFn = kind==='expense' ? mergedExpenseCategories : mergedIncomeSubcats;

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.addEventListener('click', e=>e.stopPropagation());
  scrim.appendChild(dialog);

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Add line item to budget';
  dialog.appendChild(title);

  // Category / subcategory — default to whatever's currently selected in
  // the ledger, but changeable here so the new item can be filed elsewhere
  // without closing the modal and re-selecting a different row first.
  // Grouped together (and below, description+amount grouped together) so
  // the modal reads as distinct sections with visible breathing room
  // between them, rather than one long uniform list of fields.
  const NEW_OPTION = '__new__';

  // A hidden-by-default text input that appears next to a select once its
  // "+ New" option is chosen, for typing the new category/subcategory
  // name — the select shrinks to share the row with it. No label above
  // it — the placeholder alone identifies the field.
  function makeNewNameInput(placeholder){
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-pill-input modal-inline-new';
    input.placeholder = placeholder;
    input.hidden = true;
    return input;
  }
  // Prepends "+ New" above whatever real category/subcategory options are
  // already in the select.
  // Native <select> arrows sit flush against the edge with no control over
  // spacing, so the default appearance is suppressed (via CSS) in favor of
  // a positioned chevron icon with real padding from the pill's right edge.
  function wrapSelect(select){
    const wrap = document.createElement('div');
    wrap.className = 'modal-select-wrap';
    const chevron = document.createElement('img');
    chevron.className = 'modal-select-chevron';
    chevron.src = 'icons/chevron-right.svg';
    chevron.alt = '';
    wrap.appendChild(select);
    wrap.appendChild(chevron);
    return wrap;
  }
  function addNewOption(select){
    const opt = document.createElement('option');
    opt.value = NEW_OPTION;
    opt.textContent = '+ New';
    select.insertBefore(opt, select.firstChild);
    return opt;
  }

  const catSubGroup = document.createElement('div');
  catSubGroup.className = 'modal-group';
  dialog.appendChild(catSubGroup);

  const catField = document.createElement('div');
  catField.className = 'modal-field';
  const catLabel = document.createElement('div');
  catLabel.className = 'modal-field-label';
  catLabel.textContent = 'Category';
  const catRow = document.createElement('div');
  catRow.className = 'modal-inline-row';
  const catSelect = document.createElement('select');
  catSelect.className = 'modal-select';
  mergedCatsFn().forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    if (c.name === selectedSub.category) opt.selected = true;
    catSelect.appendChild(opt);
  });
  addNewOption(catSelect);
  catField.appendChild(catLabel);
  catField.appendChild(catRow);
  catRow.appendChild(wrapSelect(catSelect));
  catSubGroup.appendChild(catField);

  const catNewInput = makeNewNameInput('Category name');
  catRow.appendChild(catNewInput);
  const syncCatNew = () => { catNewInput.hidden = catSelect.value !== NEW_OPTION; };
  syncCatNew();

  const subField = document.createElement('div');
  subField.className = 'modal-field';
  const subLabel = document.createElement('div');
  subLabel.className = 'modal-field-label';
  subLabel.textContent = 'Subcategory';
  const subRow = document.createElement('div');
  subRow.className = 'modal-inline-row';
  const subSelect = document.createElement('select');
  subSelect.className = 'modal-select';
  subField.appendChild(subLabel);
  subField.appendChild(subRow);
  subRow.appendChild(wrapSelect(subSelect));
  catSubGroup.appendChild(subField);

  const subNewInput = makeNewNameInput('Subcategory name');
  subRow.appendChild(subNewInput);
  const syncSubNew = () => { subNewInput.hidden = subSelect.value !== NEW_OPTION; };

  const populateSubs = (catName, preferredSub) => {
    subSelect.innerHTML = '';
    if (catName !== NEW_OPTION){
      const cat = mergedCatsFn().find(c=>c.name===catName);
      (cat ? cat.subcategories : []).forEach(s=>{
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        if (s.name === preferredSub) opt.selected = true;
        subSelect.appendChild(opt);
      });
    }
    const newOpt = addNewOption(subSelect);
    // A brand-new category has no existing subcategories yet, so force
    // "+ New" rather than leaving the select empty.
    if (catName === NEW_OPTION) newOpt.selected = true;
    syncSubNew();
  };
  populateSubs(selectedSub.category, selectedSub.subcategory);
  subSelect.addEventListener('change', syncSubNew);
  catSelect.addEventListener('change', () => {
    populateSubs(catSelect.value, null);
    syncCatNew();
  });

  const descAmountGroup = document.createElement('div');
  descAmountGroup.className = 'modal-group';
  dialog.appendChild(descAmountGroup);

  const labelField = document.createElement('div');
  labelField.className = 'modal-field';
  const labelFieldLabel = document.createElement('div');
  labelFieldLabel.className = 'modal-field-label';
  labelFieldLabel.textContent = 'Description';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'modal-pill-input';
  labelInput.placeholder = 'Description';
  labelField.appendChild(labelFieldLabel);
  labelField.appendChild(labelInput);
  descAmountGroup.appendChild(labelField);

  const amountField = document.createElement('div');
  amountField.className = 'modal-field';
  const amountFieldLabel = document.createElement('div');
  amountFieldLabel.className = 'modal-field-label';
  amountFieldLabel.textContent = 'Amount';
  const amountInput = document.createElement('input');
  amountInput.type = 'number';
  amountInput.step = '1';
  amountInput.className = 'modal-pill-input num';
  amountInput.placeholder = '0';
  amountField.appendChild(amountFieldLabel);
  amountField.appendChild(amountInput);
  descAmountGroup.appendChild(amountField);

  // Frequency picker — a pill toggle group (same look as the Expenses/
  // Income and YTD/Projection/Plan pills elsewhere) instead of a <select>,
  // so more than one month can be picked at once. "Every month" and
  // specific months are mutually exclusive: picking a month clears "Every
  // month", and vice versa; multiple specific months can stay selected
  // together (e.g. a one-time item in both June and December).
  const selectedFreqs = new Set(['monthly']);
  const freqPillEls = {};
  const syncFreqPills = () => {
    Object.entries(freqPillEls).forEach(([val,el])=>el.classList.toggle('active', selectedFreqs.has(val)));
  };

  const freqField = document.createElement('div');
  freqField.className = 'modal-field';
  const freqLabel = document.createElement('div');
  freqLabel.className = 'modal-field-label';
  freqLabel.textContent = 'Month';
  freqField.appendChild(freqLabel);
  dialog.appendChild(freqField);

  const freqSection = document.createElement('div');
  freqSection.className = 'freq-section';
  freqField.appendChild(freqSection);

  const allPill = document.createElement('button');
  allPill.type = 'button';
  allPill.className = 'pill freq-pill freq-pill-all';
  allPill.textContent = 'Every month';
  allPill.addEventListener('click', ()=>{
    selectedFreqs.clear();
    selectedFreqs.add('monthly');
    syncFreqPills();
  });
  freqPillEls.monthly = allPill;
  freqSection.appendChild(allPill);

  const monthsGrid = document.createElement('div');
  monthsGrid.className = 'freq-months-grid';
  MONTHS.forEach((m,i)=>{
    const val = MONTH_ABBR[i];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill freq-pill';
    b.textContent = m;
    b.addEventListener('click', ()=>{
      selectedFreqs.delete('monthly');
      if (selectedFreqs.has(val)) selectedFreqs.delete(val); else selectedFreqs.add(val);
      syncFreqPills();
    });
    freqPillEls[val] = b;
    monthsGrid.appendChild(b);
  });
  freqSection.appendChild(monthsGrid);
  syncFreqPills();

  const actions = document.createElement('div');
  actions.className = 'add-plan-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'file-btn ghost';
  cancelBtn.textContent = 'Cancel';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'file-btn primary';
  addBtn.textContent = 'Add';
  actions.appendChild(cancelBtn);
  actions.appendChild(addBtn);
  dialog.appendChild(actions);

  function close(){
    document.removeEventListener('keydown', onKeydown);
    scrim.remove();
  }
  function onKeydown(e){
    if (e.key === 'Escape') close();
  }
  scrim.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  addBtn.addEventListener('click', ()=>{
    if (selectedFreqs.size === 0) return;

    let categoryName = catSelect.value;
    if (categoryName === NEW_OPTION){
      categoryName = catNewInput.value.trim();
      if (!categoryName){ catNewInput.focus(); return; }
    }
    let subcategoryName = subSelect.value;
    if (subcategoryName === NEW_OPTION){
      subcategoryName = subNewInput.value.trim();
      if (!subcategoryName){ subNewInput.focus(); return; }
    }
    const target = { kind, category: categoryName, subcategory: subcategoryName };
    let anyAdded = false;
    selectedFreqs.forEach(freq=>{
      if (addSelectedBudgetItem(freq, labelInput.value, amountInput.value, target)) anyAdded = true;
    });
    if (!anyAdded){
      amountInput.focus();
      return;
    }
    close();
    renderMid();
    renderRight();
  });
  document.addEventListener('keydown', onKeydown);

  document.body.appendChild(scrim);
  labelInput.focus();
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
        rows.push({ dateLabel: (parseInt(t.date.slice(5,7),10))+'/'+(parseInt(t.date.slice(8,10),10)), description: t.description, amount: t.amount, planned: false });
      });
    } else {
      items.forEach(it=>{
        const v = it.monthly[m];
        if (v) rows.push({ dateLabel: MONTHS[m], description: it.label, amount: v, planned: true });
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

document.getElementById('editBudgetBtn').addEventListener('click', enterBudgetEditor);

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
