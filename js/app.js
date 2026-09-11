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
  // "Today", for per-diem forecasting (see itemCurrentMonthSplit) — the
  // latest day-of-month among transactions actually falling in
  // currentMonthIndex, not just the single latest date overall, so it
  // stays consistent with how currentMonthIndex itself is derived above.
  const currentDay = currentMonthIndex === null ? null :
    rows.reduce((max,r)=> r.date.getMonth()===currentMonthIndex ? Math.max(max, r.date.getDate()) : max, 0);

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
    year, months: MONTHS, monthsPresent, currentMonthIndex, currentDay,
    income: income.map(v=>Math.round(v*100)/100),
    incomeSubcats,
    expenses: expenses.map(v=>Math.round(v*100)/100),
    net, categories, transactions, sourceFiles,
  };
}

function emptyData(){
  return {
    year: new Date().getFullYear(), months: MONTHS, monthsPresent: [], currentMonthIndex: null, currentDay: null,
    income: new Array(12).fill(0), incomeSubcats: [],
    expenses: new Array(12).fill(0), net: new Array(12).fill(0), categories: [],
    transactions: [], sourceFiles: [],
  };
}

/* ============================================================
   BUDGETS — line-item schema + resolver
   {
     "Expenses": { "<Category>": { "<Subcategory>": [ {freq,amountType,linkedDescriptions,label,amount}, ... ] } },
     "Income":   { "<Subcategory>": [ {freq,amountType,linkedDescriptions,label,amount}, ... ] }
   }
   freq: "monthly" (scalar or 12-array) | 3-letter month code ("jan".."dec",
         scalar, one-time). "daily" is also still accepted when reading —
         see isPerDiemItem below — but the editor no longer writes it.
   amountType: "monthly" (default — amount is the flat total for whichever
         month(s) freq applies to) | "perDiem" (amount is a per-day rate,
         scaled by the number of days in each of those months).
   linkedDescriptions: string[] (default []) — raw transaction descriptions
         (see budget-editor's "Link" control on each item) this item is
         explicitly tied to. Only meaningful for a non-per-diem item, and
         only changes anything for the CURRENT month: see resolveBudgets'
         linked/unlinked split for how a linked item's matched actual
         spend this month combines with its plan (a "spending cap" —
         forecast is whichever's bigger of the two), and how unlinked
         items/unclaimed actual spend fall back to the old subcategory-
         level comparison.
   ============================================================ */
function daysInMonth(year, monthIndex){ return new Date(year, monthIndex+1, 0).getDate(); }
// Days left in a month counting from (and including) currentDay+1 through
// the end of the month — e.g. August (31 days) with currentDay 17 leaves
// 14. Clamped to 0 so a month already fully behind "today" never goes
// negative.
function remainingDaysInMonth(year, monthIndex, currentDay){
  if (currentDay == null) return 0;
  return Math.max(0, daysInMonth(year, monthIndex) - currentDay);
}

// A line item counts as per diem either via the current amountType field,
// or — for line items saved before that field existed — via the legacy
// freq:"daily" value, which meant exactly the same thing (a per-day rate,
// applied every month). Budget-editor items get freq:"daily" normalized
// away on load (see budgetsRawToDraft), but raw BUDGETS_RAW read directly
// off disk (the read-only Plan/YTD/Forecast views, until the file is
// re-exported) can still carry it, so both forms are checked everywhere a
// line item's amount type matters.
function isPerDiemItem(item){
  return item.amountType === 'perDiem' || (item.freq||'').toLowerCase() === 'daily';
}

// Whether a line item's freq targets the given month at all — "monthly"
// (recurring every month) always does; a specific month code ("jan" etc.,
// a one-time item) only targets that one month.
function itemAppliesToMonth(item, monthIndex){
  const freq = (item.freq||'').toLowerCase();
  const effectiveFreq = freq === 'daily' ? 'monthly' : freq;
  return effectiveFreq === 'monthly' || MONTH_ABBR.indexOf(effectiveFreq) === monthIndex;
}

function resolveLineItem(item, year){
  const arr = new Array(12).fill(0);
  const freq = (item.freq||'').toLowerCase();
  const effectiveFreq = freq === 'daily' ? 'monthly' : freq;
  const perDiem = isPerDiemItem(item);
  const monthValue = (monthIndex) => {
    const v = Number(item.amount)||0;
    return perDiem ? v * daysInMonth(year, monthIndex) : v;
  };
  if (effectiveFreq === 'monthly'){
    if (Array.isArray(item.amount)){
      // An explicit 12-value array is already a literal total per month —
      // amountType doesn't apply to it.
      for (let i=0;i<12;i++) arr[i] = item.amount[i] || 0;
    } else {
      for (let i=0;i<12;i++) arr[i] = monthValue(i);
    }
  } else {
    const mi = MONTH_ABBR.indexOf(effectiveFreq);
    if (mi !== -1) arr[mi] = monthValue(mi);
  }
  return arr.map(v=>Math.round(v*100)/100);
}

// This line item's contribution to the CURRENT (possibly partial) month
// specifically, split into two pieces that combine differently with actual
// spend in the Forecast pill (see projectedMonthly):
//   - flat: a per-month (non-per-diem) item's ordinary full-month value,
//     which merges into the existing actual-vs-full-month-plan comparison.
//   - perDiemRemaining: a per diem item's rate times only the days left in
//     the month, always added on top of that comparison — e.g. a $10/day
//     item with 14 days left in August contributes $140 here, regardless
//     of what's already been spent this month.
// Returns zeros when there's no current month to speak of, when the item
// doesn't apply to it, or (for an explicit per-month array amount, which
// has no meaningful per diem interpretation) always via the flat side.
function itemCurrentMonthSplit(item, year, cmi, currentDay){
  if (cmi == null) return { flat: 0, perDiemRemaining: 0 };
  if (!itemAppliesToMonth(item, cmi)) return { flat: 0, perDiemRemaining: 0 };
  if (Array.isArray(item.amount)){
    return { flat: item.amount[cmi] || 0, perDiemRemaining: 0 };
  }
  const v = Number(item.amount) || 0;
  if (isPerDiemItem(item)){
    return { flat: 0, perDiemRemaining: v * remainingDaysInMonth(year, cmi, currentDay) };
  }
  return { flat: v, perDiemRemaining: 0 };
}

// A transaction's category/subcategory fields mean something different per
// type (see aggregate()'s income-tree comment): an Expense transaction's
// own category/subcategory line up directly with the budget's Category ->
// Subcategory; an Income transaction's budget "Category" is actually its
// CSV Subcategory (the source, e.g. "Salary") and its budget "Subcategory"
// is actually its Description (income is rolled up per unique description).
function transactionMatchesBudgetSlot(t, txnType, catName, subName){
  if (txnType === 'Income') return t.subcategory === catName && t.description === subName;
  return t.category === catName && t.subcategory === subName;
}

// Sum of this month's actual transactions (in the given budget slot) whose
// description is one of this item's linkedDescriptions — the "matched
// actual" side of a linked item's spending-cap comparison (see
// resolveBudgets). Signed the same way item.amount already is (negative
// for an expense), since transaction amounts share that same convention.
function itemMatchedActual(transactions, txnType, catName, subName, cmi, linkedDescriptions){
  if (cmi == null || !linkedDescriptions || !linkedDescriptions.length) return 0;
  const set = new Set(linkedDescriptions);
  return transactions.reduce((sum,t)=>{
    if (t.type !== txnType || t.month !== cmi || !set.has(t.description)) return sum;
    if (!transactionMatchesBudgetSlot(t, txnType, catName, subName)) return sum;
    return sum + t.amount;
  }, 0);
}

function resolveBudgets(raw, year, cmi, currentDay, transactions){
  const txns = transactions || [];
  // Expenses and Income share the same Category -> Subcategory -> items
  // shape, so both groups resolve through the same logic.
  const resolveGroup = (groupRaw, txnType) => {
    const out = {};
    Object.entries(groupRaw||{}).forEach(([catName, subs])=>{
      out[catName] = {};
      Object.entries(subs||{}).forEach(([subName, items])=>{
        const list = Array.isArray(items) ? items : [];
        const resolvedItems = list.map(it=>({
          freq: it.freq, amountType: it.amountType,
          linkedDescriptions: Array.isArray(it.linkedDescriptions) ? it.linkedDescriptions.slice() : [],
          label: it.label||subName, amount: it.amount,
          monthly: resolveLineItem(it, year),
        }));
        const monthly = new Array(12).fill(0);
        resolvedItems.forEach(it=>it.monthly.forEach((v,i)=>monthly[i]+=v));

        // Current month's figure — per diem items keep contributing their
        // always-additive remaining-days amount exactly as before (see
        // itemCurrentMonthSplit). Flat items split into linked (this
        // item's own matched-actual-vs-planned spending-cap comparison —
        // see itemMatchedActual) and unlinked (pooled with whatever actual
        // spend nothing has claimed yet, compared the old subcategory-wide
        // whichever's-bigger way). A subcategory where nothing is linked
        // degrades to exactly the old behavior: linkedForecast is 0, and
        // the unlinked pool covers every item and every actual dollar.
        let perDiemRemainingCmi = 0;
        let linkedForecastCmi = 0;
        let unlinkedPlanCmi = 0;
        const claimedDescriptions = new Set();
        list.forEach(it=>{
          if (!isPerDiemItem(it) && it.linkedDescriptions && it.linkedDescriptions.length){
            it.linkedDescriptions.forEach(d=>claimedDescriptions.add(d));
          }
        });
        list.forEach(it=>{
          const split = itemCurrentMonthSplit(it, year, cmi, currentDay);
          perDiemRemainingCmi += split.perDiemRemaining;
          if (isPerDiemItem(it) || cmi == null || !itemAppliesToMonth(it, cmi)) return;
          const hasLinks = it.linkedDescriptions && it.linkedDescriptions.length > 0;
          if (!hasLinks){
            unlinkedPlanCmi += split.flat;
            return;
          }
          const matched = itemMatchedActual(txns, txnType, catName, subName, cmi, it.linkedDescriptions);
          const planned = split.flat;
          linkedForecastCmi += Math.abs(matched) > Math.abs(planned) ? matched : planned;
        });
        const residualActual = cmi == null ? 0 : txns.reduce((sum,t)=>{
          if (t.type !== txnType || t.month !== cmi || claimedDescriptions.has(t.description)) return sum;
          if (!transactionMatchesBudgetSlot(t, txnType, catName, subName)) return sum;
          return sum + t.amount;
        }, 0);
        const unlinkedForecastCmi = Math.abs(residualActual) > Math.abs(unlinkedPlanCmi) ? residualActual : unlinkedPlanCmi;
        const flatCmi = linkedForecastCmi + unlinkedForecastCmi;

        out[catName][subName] = {
          monthly: monthly.map(v=>Math.round(v*100)/100), items: resolvedItems,
          flatCmi: Math.round(flatCmi*100)/100,
          perDiemRemainingCmi: Math.round(perDiemRemainingCmi*100)/100,
        };
      });
    });
    return out;
  };
  return {
    expenses: resolveGroup(raw && raw.Expenses, 'Expenses'),
    income: resolveGroup(raw && raw.Income, 'Income'),
  };
}

// Derived, aggregated views built once per render from the resolved budgets.
function buildBudgetRollups(resolved, categories, incomeSubcats){
  // Expense category monthly = sum of its subcats' monthly, SIGN-FLIPPED to a
  // positive "planned spend" magnitude (matches Actual sign convention).
  const expenseCategoryMonthly = {}; // catName -> [12] positive
  const expenseSubMonthly = {};      // "cat||sub" -> [12] positive
  // Current-month figures (see resolveBudgets) — flatCmi is already a
  // fully-resolved forecast (linked items' spending-cap comparisons plus
  // the unlinked pool's whichever's-bigger), and perDiemRemainingCmi is
  // the always-additive per diem remainder — rolled up the same bottom-up
  // way and sign-flipped alongside monthly. catName/"cat||sub" -> scalar
  // positive, used only by the Forecast pill's current-month figure (see
  // projectedMonthly, which now just adds these two together).
  const expenseCategoryFlatCmi = {};
  const expenseCategoryPerDiemRemainingCmi = {};
  const expenseSubFlatCmi = {};
  const expenseSubPerDiemRemainingCmi = {};
  Object.entries(resolved.expenses).forEach(([catName, subs])=>{
    const catArr = new Array(12).fill(0);
    let catFlat = 0, catPerDiemRemaining = 0;
    Object.entries(subs).forEach(([subName, subData])=>{
      const posArr = subData.monthly.map(v=>-v);
      const key = catName+'||'+subName;
      expenseSubMonthly[key] = posArr;
      posArr.forEach((v,i)=>catArr[i]+=v);
      expenseSubFlatCmi[key] = -subData.flatCmi;
      expenseSubPerDiemRemainingCmi[key] = -subData.perDiemRemainingCmi;
      catFlat += expenseSubFlatCmi[key];
      catPerDiemRemaining += expenseSubPerDiemRemainingCmi[key];
    });
    expenseCategoryMonthly[catName] = catArr.map(v=>Math.round(v*100)/100);
    expenseCategoryFlatCmi[catName] = Math.round(catFlat*100)/100;
    expenseCategoryPerDiemRemainingCmi[catName] = Math.round(catPerDiemRemaining*100)/100;
  });
  const expenseTotalMonthly = new Array(12).fill(0);
  Object.values(expenseCategoryMonthly).forEach(arr=>arr.forEach((v,i)=>expenseTotalMonthly[i]+=v));
  const expenseTotalFlatCmi = Object.values(expenseCategoryFlatCmi).reduce((a,b)=>a+b,0);
  const expenseTotalPerDiemRemainingCmi = Object.values(expenseCategoryPerDiemRemainingCmi).reduce((a,b)=>a+b,0);

  // Income category (source) monthly = sum of its subcategories' (rolled-up
  // description) monthly — already positive, no sign flip needed. Same
  // bottom-up shape as expenses above.
  const incomeCategoryMonthly = {}; // catName -> [12] positive
  const incomeSubMonthly = {};      // "cat||sub" -> [12] positive
  const incomeCategoryFlatCmi = {};
  const incomeCategoryPerDiemRemainingCmi = {};
  const incomeSubFlatCmi = {};
  const incomeSubPerDiemRemainingCmi = {};
  Object.entries(resolved.income).forEach(([catName, subs])=>{
    const catArr = new Array(12).fill(0);
    let catFlat = 0, catPerDiemRemaining = 0;
    Object.entries(subs).forEach(([subName, subData])=>{
      const key = catName+'||'+subName;
      incomeSubMonthly[key] = subData.monthly.slice();
      subData.monthly.forEach((v,i)=>catArr[i]+=v);
      incomeSubFlatCmi[key] = subData.flatCmi;
      incomeSubPerDiemRemainingCmi[key] = subData.perDiemRemainingCmi;
      catFlat += incomeSubFlatCmi[key];
      catPerDiemRemaining += incomeSubPerDiemRemainingCmi[key];
    });
    incomeCategoryMonthly[catName] = catArr.map(v=>Math.round(v*100)/100);
    incomeCategoryFlatCmi[catName] = Math.round(catFlat*100)/100;
    incomeCategoryPerDiemRemainingCmi[catName] = Math.round(catPerDiemRemaining*100)/100;
  });
  const incomeTotalMonthly = new Array(12).fill(0);
  Object.values(incomeCategoryMonthly).forEach(arr=>arr.forEach((v,i)=>incomeTotalMonthly[i]+=v));
  const incomeTotalFlatCmi = Object.values(incomeCategoryFlatCmi).reduce((a,b)=>a+b,0);
  const incomeTotalPerDiemRemainingCmi = Object.values(incomeCategoryPerDiemRemainingCmi).reduce((a,b)=>a+b,0);

  return {
    expenseCategoryMonthly, expenseSubMonthly, expenseTotalMonthly,
    incomeCategoryMonthly, incomeSubMonthly, incomeTotalMonthly,
    expenseCategoryFlatCmi, expenseCategoryPerDiemRemainingCmi,
    expenseSubFlatCmi, expenseSubPerDiemRemainingCmi,
    expenseTotalFlatCmi, expenseTotalPerDiemRemainingCmi,
    incomeCategoryFlatCmi, incomeCategoryPerDiemRemainingCmi,
    incomeSubFlatCmi, incomeSubPerDiemRemainingCmi,
    incomeTotalFlatCmi, incomeTotalPerDiemRemainingCmi,
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
  // Normalizes the legacy freq:"daily" value (see isPerDiemItem) into the
  // current freq/amountType pair as soon as a raw item enters the editor,
  // so the editor's two dropdowns always agree with what's actually
  // stored — resolveLineItem/itemCurrentMonthSplit still accept the
  // legacy form directly for files that never get re-opened here.
  const toItems = (items, fallbackLabel) => (Array.isArray(items) ? items : []).map(it => {
    const legacyDaily = (it.freq||'').toLowerCase() === 'daily';
    return {
      id: nextBudgetId(),
      freq: legacyDaily ? 'monthly' : (it.freq || 'monthly'),
      amountType: it.amountType || (legacyDaily ? 'perDiem' : 'monthly'),
      linkedDescriptions: Array.isArray(it.linkedDescriptions) ? it.linkedDescriptions.slice() : [],
      label: it.label != null ? it.label : fallbackLabel,
      amount: it.amount,
    };
  });
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
    .map(it => ({
      freq: it.freq, amountType: it.amountType || 'monthly',
      linkedDescriptions: Array.isArray(it.linkedDescriptions) ? it.linkedDescriptions.slice() : [],
      label: it.label, amount: it.amount,
    }));
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
function budgetItemMonthly(item){
  return resolveLineItem({ freq: item.freq, amountType: item.amountType, amount: item.amount }, DATA.year);
}
function budgetItemYearTotal(item){
  return budgetItemMonthly(item).reduce((a, b) => a + b, 0);
}
function budgetSubMonthly(sub){
  const out = new Array(12).fill(0);
  sub.items.forEach(it => budgetItemMonthly(it).forEach((v,i)=>out[i]+=v));
  return out.map(v=>Math.round(v*100)/100);
}
function budgetSubYearTotal(sub){
  return sub.items.reduce((a, it) => a + budgetItemYearTotal(it), 0);
}
function budgetCatYearTotal(cat){
  return cat.subcategories.reduce((a, s) => a + budgetSubYearTotal(s), 0);
}
// Per-month display arrays for the budget editor's ledger table — computed
// straight from the draft's own category/subcategory objects (by reference,
// via budgetSubMonthly above) rather than by round-tripping through
// draftToBudgetsRaw/resolveBudgets/buildBudgetRollups, so two categories or
// subcategories that happen to share a name (e.g. both freshly added and
// still blank) never collide the way a name-keyed rollup would. Expense
// amounts are stored negative (spend) same as everywhere else in the app;
// flipped here to a positive "planned spend" magnitude for display, matching
// buildBudgetRollups' sign convention for every other ledger table.
function budgetSubDisplayMonthly(sub, kind){
  const raw = budgetSubMonthly(sub);
  return kind === 'expense' ? raw.map(v=>-v) : raw;
}
function budgetCatDisplayMonthly(cat, kind){
  const out = new Array(12).fill(0);
  cat.subcategories.forEach(sub => budgetSubDisplayMonthly(sub, kind).forEach((v,i)=>out[i]+=v));
  return out.map(v=>Math.round(v*100)/100);
}
function budgetGroupDisplayMonthly(list, kind){
  const out = new Array(12).fill(0);
  list.forEach(cat => budgetCatDisplayMonthly(cat, kind).forEach((v,i)=>out[i]+=v));
  return out.map(v=>Math.round(v*100)/100);
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
  budgetOpenCats = new Set();
  budgetSelection = null;
  budgetSummaryEls = null;
  budgetRightSubTotalEl = null;
  searchQuery = '';
  // The status bar's Open/Change file inputs are disabled for the duration
  // of edit mode (renderStatusBar reads budgetEditMode directly), so no
  // manual enable/disable bookkeeping is needed here.
  renderAll();
}
function exitBudgetEditor(){
  budgetEditMode = false;
  budgetDraft = null;
  budgetSelection = null;
  budgetSummaryEls = null;
  budgetRightSubTotalEl = null;
}
function cancelBudgetEdit(){
  exitBudgetEditor();
  renderAll();
}
function saveBudgetEdit(){
  BUDGETS_RAW = draftToBudgetsRaw(budgetDraft);
  // Saving only commits the draft in-memory — the status bar's "(edited)"
  // badge and Export button (see renderStatusBar) are what tell the user
  // it still needs exporting to a file.
  budgetDirty = true;
  recomputeDerived();
  exitBudgetEditor();
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
          draftSub.items.push({ id: nextBudgetId(), freq: 'monthly', amountType: 'monthly', linkedDescriptions: [], label: `${sub.name} (last year avg)`, amount: -avgMonthly });
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
          draftSub.items.push({ id: nextBudgetId(), freq: 'monthly', amountType: 'monthly', linkedDescriptions: [], label: `${sub.name} (last year avg)`, amount: avgMonthly });
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
let BUDGETS = resolveBudgets(BUDGETS_RAW, DATA.year, DATA.currentMonthIndex, DATA.currentDay, DATA.transactions);
let ROLL = buildBudgetRollups(BUDGETS, DATA.categories, DATA.incomeSubcats);

// Budget file identity, for the status bar (see renderStatusBar). Loaded
// transaction filenames live on DATA.sourceFiles instead — transactions
// have no edit/export lifecycle of their own, so they need no equivalent
// of budgetDirty.
let budgetFileName = null;   // name of the last-loaded/last-exported budget JSON, or null if never loaded/exported
let budgetDirty = false;     // true once BUDGETS_RAW holds edits not yet exported to a file

let timeframe = 'year';      // 'year' | 0-11 (month index) | 'transactions'
let monthViewOrigin = 'year'; // timeframe to return to via the month view's back button
let pill = 'ytd';            // 'ytd' | 'projection' | 'plan'  (Year view only)
let openCats = new Set();
// Which of the Year/Month tables' Income/Spending groups are expanded,
// revealing their category rows. Both start open so the breakdown is
// visible right away; independent from openCats, which tracks individual
// category rows within an already-expanded group.
let openGroups = new Set(['income','expenses']);
let selectedSub = null;      // { kind:'expense'|'income', category, subcategory } | null — for income, category is the
                              // top-level income source and subcategory is a rolled-up transaction description
let searchQuery = '';
let txnSort = { key: 'date', dir: -1 }; // default: newest first

// Budget editor — a distinct "mode" (like search) that takes over the mid
// and right panels. See the BUDGET EDITOR section below.
let budgetEditMode = false;
let budgetDraft = null;      // { expenses:[{id,name,subcategories:[{id,name,items:[{id,freq,label,amount}]}]}], income:[{id,name,subcategories:[...]}] }
let budgetOpenCats = new Set();  // open category ids, editor-local (separate from openCats)
let budgetFocusPending = null;   // { catId } — after Enter commits a pending category or
                                  // subcategory row (see buildPendingCatRow/buildGroup),
                                  // focus that category's own pending-subcategory row on
                                  // the next render: naming a category flows straight into
                                  // naming its first subcategory, and committing a
                                  // subcategory flows straight into naming the next one —
                                  // either way, rapid sequential entry never needs a click
let budgetSummaryEls = null;     // right-panel live-total <span> refs while editing, when nothing is selected
let budgetSelection = null;      // { kind:'expense'|'income', catId, subId } | null — the subcategory (if any)
                                  // currently selected in the editor's table, shown/edited in the right panel
let budgetRightSubTotalEl = null; // right-panel live-total <span> ref for the selected subcategory

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

  // The Budget tab stays selected while viewing a month, too — a month
  // view is reached from (and its back button returns to) the Budget tab,
  // so it reads as a drill-down within Budget rather than a separate page.
  wrap.appendChild(navItem('Budget', 'year', timeframe === 'year' || typeof timeframe === 'number'));
  wrap.appendChild(navItem('Transactions', 'transactions'));

  // Individual month tabs used to live here, each showing that month's net
  // value (via monthPlanNet/DATA.net) — a month view is now reached by
  // clicking that month's column header in the Year table instead, and the
  // remaining left-nav tabs no longer show a net dollar figure at all.
  // monthPlanNet is kept for that per-month net figure, since it'll be
  // needed again once the month view (or its header) surfaces it elsewhere.
}
function navItem(label, key, isActive){
  const div = document.createElement('div');
  div.className = 'tf-item' + ((isActive ?? timeframe===key) ? ' active' : '');
  div.innerHTML = `<span class="tf-label">${label}</span>`;
  div.addEventListener('click', ()=>{
    timeframe = key;
    // The transactions filter is local to that tab — leaving it resets the
    // filter so Transactions is back to showing everything next time.
    searchQuery = '';
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

// opts.resetScroll: renderMid() rebuilds the table (and its .table-scroll
// wrapper) from scratch on every call, which would otherwise always reset
// scroll position to the top — fine for an actual page change (a new
// timeframe/tab/mode, always routed through renderAll(), which passes
// resetScroll:true), but wrong for an in-place update that should leave
// you exactly where you were (selecting/expanding a row, editing a budget
// item, deleting a category, ...) — every OTHER caller of renderMid()
// preserves scroll by default.
function renderMid(opts){
  const preserveScroll = !(opts && opts.resetScroll);
  const mid = document.getElementById('midPanel');
  let savedScrollTop = 0, savedScrollLeft = 0;
  if (preserveScroll){
    const prevScroll = mid.querySelector('.table-scroll');
    if (prevScroll){ savedScrollTop = prevScroll.scrollTop; savedScrollLeft = prevScroll.scrollLeft; }
  }
  // Applying scrollTop/scrollLeft only needs layout (which the browser
  // computes synchronously on demand), not an actual painted frame, so
  // this runs synchronously right before each of this function's exit
  // points below rather than being deferred — no flash of "scrolled to
  // top" first, and no dependency on a rAF callback actually getting
  // scheduled (e.g. while the tab is backgrounded).
  function restoreScroll(){
    if (!savedScrollTop && !savedScrollLeft) return;
    const ts = mid.querySelector('.table-scroll');
    if (ts){ ts.scrollTop = savedScrollTop; ts.scrollLeft = savedScrollLeft; }
  }
  mid.innerHTML = '';

  if (budgetEditMode){
    renderBudgetEditor(mid);
    if (budgetFocusPending){
      const catId = budgetFocusPending.catId;
      budgetFocusPending = null;
      // The row Enter just committed is gone from the DOM (rebuilt as a
      // real category/subcategory row further up the list) — what we want
      // focus on is that category's pending-subcategory row, always blank,
      // so a plain focus() is enough (nothing to position a cursor
      // within).
      const el = mid.querySelector(`tr.sub-row.pending[data-cat-id="${catId}"] .budget-name-input`);
      if (el) el.focus();
    }
    restoreScroll();
    return;
  }

  if (timeframe === 'transactions'){
    renderTransactionsPage(mid);
    restoreScroll();
    return;
  }

  const body = document.createElement('div');
  body.className = 'mid-body';

  if (timeframe === 'year'){
    const bar = document.createElement('div');
    bar.className = 'mid-title year-toolbar';
    const left = document.createElement('div');
    left.className = 'year-toolbar-left';
    const yearLabel = document.createElement('span');
    // DATA.year is derived from the loaded CSV (the year with the most
    // transactions) — for now every transaction is assumed to fall in the
    // same year, so this is just that year. Once multi-year data is
    // supported this title will need to reflect that instead.
    yearLabel.textContent = String(DATA.year);
    left.appendChild(yearLabel);
    left.appendChild(renderPills());
    bar.appendChild(left);
    // Export/Edit only make sense while looking at the plan itself, not
    // the YTD/Forecast actuals-driven views.
    if (pill === 'plan') bar.appendChild(renderBudgetActions());
    mid.appendChild(bar);
    // No summary cards here — the Net/Income/Spending rows built into the
    // table below (see renderYearTable) replace them.
    body.appendChild(wrapScroll(renderYearTable()));
  } else {
    const bar = document.createElement('div');
    bar.className = 'mid-title month-toolbar';

    const left = document.createElement('div');
    left.className = 'month-toolbar-left';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'back-btn';
    backBtn.title = 'Back to Budget';
    backBtn.innerHTML = `<img src="icons/chevron-left.svg" alt="Back to Budget">`;
    // Always returns to whatever view the month was opened from — prev/next
    // month navigation below only ever changes timeframe, never
    // monthViewOrigin, so this keeps working the same regardless of how
    // many months the user has stepped through.
    backBtn.addEventListener('click', ()=>{
      timeframe = monthViewOrigin;
      renderAll();
    });
    left.appendChild(backBtn);
    const titleText = document.createElement('span');
    titleText.textContent = `${monthFullName(timeframe)} ${DATA.year}`;
    left.appendChild(titleText);
    bar.appendChild(left);

    const nav = document.createElement('div');
    nav.className = 'month-toolbar-nav';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'back-btn';
    prevBtn.title = 'Previous month';
    prevBtn.innerHTML = `<img src="icons/chevron-left.svg" alt="Previous month">`;
    prevBtn.disabled = timeframe === 0;
    prevBtn.addEventListener('click', ()=>{
      timeframe = timeframe - 1;
      renderAll();
    });
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'back-btn';
    nextBtn.title = 'Next month';
    nextBtn.innerHTML = `<img src="icons/chevron-right.svg" alt="Next month">`;
    nextBtn.disabled = timeframe === 11;
    nextBtn.addEventListener('click', ()=>{
      timeframe = timeframe + 1;
      renderAll();
    });
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);

    const right = document.createElement('div');
    right.className = 'month-toolbar-right';
    right.appendChild(nav);
    bar.appendChild(right);

    mid.appendChild(bar);
    // No summary cards here — same as the Year view, the Net/Income/
    // Spending rows built into the table below replace them.
    body.appendChild(wrapScroll(renderMonthTable()));
  }
  mid.appendChild(body);
  restoreScroll();
}

// Export/Edit actions — shown top-right of the Year toolbar, but only
// while the "Budget" pill (the plan itself) is active; hidden on the
// YTD/Forecast pills, the month drill-down, and the Transactions page,
// none of which are viewing the plan directly.
function renderBudgetActions(){
  const wrap = document.createElement('div');
  wrap.className = 'mid-title-actions';
  // Export now lives in the status bar (see renderStatusBar), appearing
  // there only once there's actually something unexported to save.
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'file-btn primary';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', enterBudgetEditor);
  wrap.appendChild(editBtn);
  return wrap;
}

function renderPills(){
  const wrap = document.createElement('div');
  wrap.className = 'pills';
  [['ytd','YTD'],['projection','Forecast'],['plan','Budget']].forEach(([key,label])=>{
    const b = document.createElement('button');
    b.className = 'pill' + (pill===key?' active':'');
    b.textContent = label;
    // renderMid() directly (not renderAll()) — switching YTD/Forecast/
    // Budget is an in-place update of the same table's numbers, not a
    // page change, so it should leave scroll position alone the same way
    // selecting/expanding a row does (see renderMid's resetScroll comment).
    b.addEventListener('click', ()=>{ pill = key; renderMid(); renderRight(); });
    wrap.appendChild(b);
  });
  return wrap;
}

/* ---- Blended (Projection) monthly value for a subcategory ---- */
// Past months use actual, future months use plan, same as always. The
// current month is the only special case, and — unlike before — no
// comparison happens here anymore: flatCmi already IS the resolved
// forecast for that month (each linked item's own matched-actual-vs-
// planned spending cap, plus the unlinked pool's whichever's-bigger — see
// resolveBudgets), and perDiemRemainingCmi is the always-additive per diem
// remainder, so the current month's value is just their sum. Both default
// to budgetMonthly's own current-month value / 0 so callers that don't
// have the split handy (there currently are none) still get a sane value.
function projectedMonthly(actualMonthly, budgetMonthly, flatCmi, perDiemRemainingCmi){
  const cmi = DATA.currentMonthIndex;
  const out = new Array(12).fill(0);
  for (let i=0;i<12;i++){
    if (cmi === null){ out[i] = budgetMonthly[i]; continue; }
    if (i < cmi) out[i] = actualMonthly[i];
    else if (i === cmi){
      const flatResolved = flatCmi != null ? flatCmi : budgetMonthly[i];
      const remaining = perDiemRemainingCmi || 0;
      out[i] = Math.round((flatResolved + remaining)*100)/100;
    }
    else out[i] = budgetMonthly[i];
  }
  return out;
}

// A blank spacer row between a grouped ledger table's Net/Income/Spending
// sections — wider than the table's normal row-to-row border-spacing, to
// read as a section break rather than just another row. colspan must match
// the table's column count (14 for the Year table, 4 for the Month table).
function groupGapRow(colspan){
  const tr = document.createElement('tr');
  tr.className = 'group-gap';
  tr.innerHTML = `<td colspan="${colspan}"></td>`;
  return tr;
}
function emptyGroupRow(message, colspan){
  const tr = document.createElement('tr');
  tr.className = 'empty-cat-row';
  tr.innerHTML = `<td colspan="${colspan}" class="empty-table">${message}</td>`;
  return tr;
}

/* ---- Year table ---- */
function renderYearTable(){
  const table = document.createElement('table');
  table.className = 'ledger ledger-year ledger-grouped';
  const thead = document.createElement('thead');
  // Each month header is the entry point into that month's Plan/Actual/
  // Difference view — the individual month tabs that used to live in the
  // left nav were removed in favor of clicking the column here.
  thead.innerHTML = `<tr><th></th>${MONTHS.map((m,i)=>`<th class="month-link" data-month="${i}">${m}</th>`).join('')}<th>Total</th></tr>`;
  thead.querySelectorAll('th.month-link').forEach(th=>{
    th.addEventListener('click', ()=>{
      monthViewOrigin = timeframe;
      timeframe = Number(th.dataset.month);
      renderAll();
    });
  });
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  const plannedMask = plannedMonthMask();
  const noDash = new Array(12).fill(false);
  const numCell = (v, i, dashMask) => `<td class="num${plannedMask[i]?' planned':''}">${dashMask[i]?'<span class="dash">–</span>':fmt(v)}</td>`;

  // Income and Spending render as two collapsible groups within the same
  // table (rather than the old Income/Expenses tab-switched single table),
  // topped by a non-interactive Net row summarizing both. Group totals are
  // needed for Net regardless of whether a group is currently expanded, so
  // buildGroup always computes them and only builds the detail <tr>s when
  // open — see buildGroup below.
  function buildGroup(kind, categories, catBudgetMonthly, subBudgetMonthly, cmiSplit, isOpen){
    const monthTotals = new Array(12).fill(0);
    let grandTotal = 0;
    const rows = [];
    categories.forEach(cat=>{
      const { values, dashMask } = yearRowValues(
        cat.monthly, catBudgetMonthly[cat.name] || new Array(12).fill(0),
        cmiSplit.catFlat[cat.name], cmiSplit.catPerDiem[cat.name]
      );
      values.forEach((v,i)=>monthTotals[i]+=v);
      const total = values.reduce((a,b)=>a+b,0);
      grandTotal += total;
      if (!isOpen) return;

      const isCatOpen = openCats.has(cat.name);
      const hasSelectedSub = !isCatOpen && selectedSub && selectedSub.kind===kind && selectedSub.category===cat.name;
      const tr = document.createElement('tr');
      tr.className = 'cat-row nested' + (hasSelectedSub?' has-selection':'');
      tr.innerHTML = `<td><span class="catname"><span class="arrow${isCatOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
        values.map((v,i)=>numCell(v,i,dashMask)).join('') +
        `<td class="num">${fmt(total)}</td>`;
      tr.addEventListener('click', ()=>{
        if (openCats.has(cat.name)) openCats.delete(cat.name); else openCats.add(cat.name);
        renderMid();
      });
      rows.push(tr);

      cat.subcategories.forEach(sub=>{
        const key = cat.name+'||'+sub.name;
        const subBudget = subBudgetMonthly[key] || new Array(12).fill(0);
        const { values: subVals, dashMask: subDash } = yearRowValues(
          sub.monthly, subBudget, cmiSplit.subFlat[key], cmiSplit.subPerDiem[key]
        );
        const subTotal = subVals.reduce((a,b)=>a+b,0);
        const isSel = selectedSub && selectedSub.kind===kind && selectedSub.category===cat.name && selectedSub.subcategory===sub.name;
        const sr = document.createElement('tr');
        sr.className = 'sub-row' + (isCatOpen?' open':'') + (isSel?' selected':'');
        sr.innerHTML = `<td><span class="cell-label">${sub.name}</span></td>` +
          subVals.map((v,i)=>numCell(v,i,subDash)).join('') +
          `<td class="num">${fmt(subTotal)}</td>`;
        sr.addEventListener('click', (e)=>{
          e.stopPropagation();
          selectSub({ kind, category: cat.name, subcategory: sub.name });
        });
        rows.push(sr);
      });
    });
    return { monthTotals, grandTotal, rows };
  }

  const incomeGroup = buildGroup('income', mergedIncomeSubcats(), ROLL.incomeCategoryMonthly, ROLL.incomeSubMonthly, {
    catFlat: ROLL.incomeCategoryFlatCmi, catPerDiem: ROLL.incomeCategoryPerDiemRemainingCmi,
    subFlat: ROLL.incomeSubFlatCmi, subPerDiem: ROLL.incomeSubPerDiemRemainingCmi,
  }, openGroups.has('income'));
  const spendingGroup = buildGroup('expense', mergedExpenseCategories(), ROLL.expenseCategoryMonthly, ROLL.expenseSubMonthly, {
    catFlat: ROLL.expenseCategoryFlatCmi, catPerDiem: ROLL.expenseCategoryPerDiemRemainingCmi,
    subFlat: ROLL.expenseSubFlatCmi, subPerDiem: ROLL.expenseSubPerDiemRemainingCmi,
  }, openGroups.has('expenses'));

  // Net row — derived from both groups' totals, always visible regardless
  // of which (if either) group is expanded; not collapsible or selectable.
  const netMonthTotals = incomeGroup.monthTotals.map((v,i)=>v - spendingGroup.monthTotals[i]);
  const netGrandTotal = incomeGroup.grandTotal - spendingGroup.grandTotal;
  const netCell = (v, i) => `<td class="num${plannedMask[i]?' planned':' '+signCls(v)}">${fmt(v)}</td>`;
  const netRow = document.createElement('tr');
  netRow.className = 'net-row';
  // First cell reuses the exact .catname/.arrow/.cell-label structure the
  // Income/Spending rows use (arrow permanently collapsed via CSS, never
  // interactive) so "Net" lands in precisely the same spot their label
  // sits at rest, keeping every column aligned across all three rows.
  netRow.innerHTML = `<td><span class="catname"><span class="arrow"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">Net</span></span></td>` +
    netMonthTotals.map((v,i)=>netCell(v,i)).join('') +
    `<td class="num ${signCls(netGrandTotal)}">${fmt(netGrandTotal)}</td>`;
  tbody.appendChild(netRow);
  tbody.appendChild(groupGapRow(14));

  // Group header row — bold summary line for Income or Spending, with a
  // chevron that only shows on hover (see .group-row CSS) since — unlike
  // a category row's chevron — it isn't the row's primary content.
  function groupHeaderRow(kind, label, group, totalColorClass){
    const isOpen = openGroups.has(kind);
    const tr = document.createElement('tr');
    tr.className = 'group-row' + (isOpen?' open':'');
    tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${label}</span></span></td>` +
      group.monthTotals.map((v,i)=>numCell(v,i,noDash)).join('') +
      `<td class="num ${totalColorClass}">${fmt(group.grandTotal)}</td>`;
    tr.addEventListener('click', ()=>{
      if (openGroups.has(kind)) openGroups.delete(kind); else openGroups.add(kind);
      renderMid();
    });
    return tr;
  }

  tbody.appendChild(groupHeaderRow('income', 'Income', incomeGroup, 'group-total-income'));
  if (openGroups.has('income')){
    if (incomeGroup.rows.length === 0){
      tbody.appendChild(emptyGroupRow('No income categories loaded yet.', 14));
    } else {
      incomeGroup.rows.forEach(row=>tbody.appendChild(row));
    }
  }
  tbody.appendChild(groupGapRow(14));

  tbody.appendChild(groupHeaderRow('expenses', 'Spending', spendingGroup, 'group-total-spending'));
  if (openGroups.has('expenses')){
    if (spendingGroup.rows.length === 0){
      tbody.appendChild(emptyGroupRow('No expense categories loaded yet.', 14));
    } else {
      spendingGroup.rows.forEach(row=>tbody.appendChild(row));
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
function yearRowValues(actualMonthly, budgetMonthly, flatCmi, perDiemRemainingCmi){
  if (pill === 'plan'){
    return { values: budgetMonthly, dashMask: new Array(12).fill(false) };
  }
  if (pill === 'projection'){
    return { values: projectedMonthly(actualMonthly, budgetMonthly, flatCmi, perDiemRemainingCmi), dashMask: new Array(12).fill(false) };
  }
  // ytd
  const values = actualMonthly.slice();
  const dashMask = new Array(12).fill(false).map((_,i)=>!DATA.monthsPresent.includes(i));
  return { values, dashMask };
}

/* ---- Month table (Plan / Actual / Difference) ---- */
function renderMonthTable(){
  const mi = timeframe;
  // Forecasted only means anything for the month actually in progress —
  // every other month is either fully actual already (past) or hasn't
  // started (future, where "forecast" is just the plan) — so the column
  // only appears here, never in a past/future month's drill-down.
  const isCurrentMonth = mi === DATA.currentMonthIndex;
  // No standalone "Difference" header anymore — each of Actual/Forecasted
  // carries its own difference-from-Budget as a muted "(+/-N)" right after
  // its own value, in an unlabeled column of its own (see .num-diff-col)
  // rather than merged into the same cell — a real adjacent column is what
  // lets every row's Actual (and every row's Forecasted) values themselves
  // stay right-aligned with each other, independent of how wide each row's
  // parenthesized diff happens to be. Column count is label + Budget +
  // Actual + its diff (+ Forecasted + its diff, current month only).
  const colCount = isCurrentMonth ? 6 : 4;
  const table = document.createElement('table');
  table.className = 'ledger ledger-month ledger-grouped';
  const thead = document.createElement('thead');
  // .num-value on the Actual/Forecasted headers themselves (not just the
  // body cells) — it's what drops the column's right padding, so header
  // text and column values share the exact same right edge instead of the
  // header sitting the normal 12px further left.
  thead.innerHTML = `<tr><th></th><th>Budget</th><th class="num-value">Actual</th><th></th>${isCurrentMonth?'<th class="num-value">Forecasted</th><th></th>':''}</tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  // value formatted with its own difference-from-planVal as a separate,
  // unlabeled, tightly-spaced column right after it (e.g. "530" | "(-65)")
  // — mainClass colors the value itself (e.g. Net's signCls); the diff
  // column always stays muted regardless. No difference (this column's own
  // value equals planVal) renders as a blank cell rather than a "(–)"
  // nobody needs to see — deliberately not distinguishing a genuine exact
  // match from a row with nothing going on this month; both blank.
  const numDiffCell = (value, planVal, mainClass) => {
    const cls = mainClass ? ` ${mainClass}` : '';
    const diffText = Math.round(value-planVal) === 0 ? '' : `(${fmtSigned(value-planVal)})`;
    return `<td class="num num-value${cls}">${fmt(value)}</td><td class="num num-diff-col">${diffText}</td>`;
  };
  const forecastCell = (v, planVal, mainClass) => isCurrentMonth ? numDiffCell(v, planVal, mainClass) : '';
  function rowHTML(name, actual, planVal, forecast, indent){
    return `<td${indent?' style="padding-left:30px"':''}><span class="cell-label">${name}</span></td>` +
      `<td class="num">${fmt(planVal)}</td>` +
      numDiffCell(actual, planVal) +
      forecastCell(forecast, planVal);
  }

  // Same Net/Income/Spending grouped format as the Year table (see
  // renderYearTable), just with Plan/Actual/[Forecasted] columns instead
  // of 12 months + Total. Both groups always render (no more activeTab-
  // driven single-table switch), topped by a non-interactive Net row.
  // cmiSplit mirrors the Year table's own (catFlat/catPerDiem/subFlat/
  // subPerDiem, see resolveBudgets) — only read when isCurrentMonth, so
  // callers outside that month can skip it.
  function buildGroup(kind, categories, catBudgetMonthly, subBudgetMonthly, cmiSplit, isOpen){
    let totActual = 0, totPlan = 0, totForecast = 0;
    const rows = [];
    categories.forEach(cat=>{
      const actual = cat.monthly[mi] || 0;
      const planVal = (catBudgetMonthly[cat.name]||[])[mi] || 0;
      const forecast = isCurrentMonth ? (cmiSplit.catFlat[cat.name]||0) + (cmiSplit.catPerDiem[cat.name]||0) : 0;
      totActual += actual; totPlan += planVal; totForecast += forecast;
      if (!isOpen) return;

      const isCatOpen = openCats.has(cat.name);
      const hasSelectedSub = !isCatOpen && selectedSub && selectedSub.kind===kind && selectedSub.category===cat.name;
      const tr = document.createElement('tr');
      tr.className = 'cat-row' + (hasSelectedSub?' has-selection':'');
      tr.innerHTML = `<td><span class="catname"><span class="arrow${isCatOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${cat.name}</span></span></td>` +
        `<td class="num">${fmt(planVal)}</td>` +
        numDiffCell(actual, planVal) +
        forecastCell(forecast, planVal);
      tr.addEventListener('click', ()=>{
        if (openCats.has(cat.name)) openCats.delete(cat.name); else openCats.add(cat.name);
        renderMid();
      });
      rows.push(tr);

      cat.subcategories.forEach(sub=>{
        const key = cat.name+'||'+sub.name;
        const subActual = sub.monthly[mi] || 0;
        const subPlan = (subBudgetMonthly[key]||[])[mi] || 0;
        const subForecast = isCurrentMonth ? (cmiSplit.subFlat[key]||0) + (cmiSplit.subPerDiem[key]||0) : 0;
        const isSel = selectedSub && selectedSub.kind===kind && selectedSub.category===cat.name && selectedSub.subcategory===sub.name;
        const sr = document.createElement('tr');
        sr.className = 'sub-row' + (isCatOpen?' open':'') + (isSel?' selected':'');
        sr.innerHTML = rowHTML(sub.name, subActual, subPlan, subForecast, true);
        sr.addEventListener('click', (e)=>{
          e.stopPropagation();
          selectSub({ kind, category: cat.name, subcategory: sub.name });
        });
        rows.push(sr);
      });
    });
    return { totActual, totPlan, totForecast, rows };
  }

  const incomeGroup = buildGroup('income', mergedIncomeSubcats(), ROLL.incomeCategoryMonthly, ROLL.incomeSubMonthly, {
    catFlat: ROLL.incomeCategoryFlatCmi, catPerDiem: ROLL.incomeCategoryPerDiemRemainingCmi,
    subFlat: ROLL.incomeSubFlatCmi, subPerDiem: ROLL.incomeSubPerDiemRemainingCmi,
  }, openGroups.has('income'));
  const spendingGroup = buildGroup('expense', mergedExpenseCategories(), ROLL.expenseCategoryMonthly, ROLL.expenseSubMonthly, {
    catFlat: ROLL.expenseCategoryFlatCmi, catPerDiem: ROLL.expenseCategoryPerDiemRemainingCmi,
    subFlat: ROLL.expenseSubFlatCmi, subPerDiem: ROLL.expenseSubPerDiemRemainingCmi,
  }, openGroups.has('expenses'));

  // Net row — derived from both groups' totals, always visible regardless
  // of which (if either) group is expanded; not collapsible or selectable.
  const netActual = incomeGroup.totActual - spendingGroup.totActual;
  const netPlan = incomeGroup.totPlan - spendingGroup.totPlan;
  const netForecast = incomeGroup.totForecast - spendingGroup.totForecast;
  const netRow = document.createElement('tr');
  netRow.className = 'net-row';
  netRow.innerHTML = `<td><span class="catname"><span class="arrow"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">Net</span></span></td>` +
    `<td class="num">${fmt(netPlan)}</td>` +
    numDiffCell(netActual, netPlan, signCls(netActual)) +
    forecastCell(netForecast, netPlan, signCls(netForecast));
  tbody.appendChild(netRow);
  tbody.appendChild(groupGapRow(colCount));

  function groupHeaderRow(kind, label, group, totalColorClass){
    const isOpen = openGroups.has(kind);
    const tr = document.createElement('tr');
    tr.className = 'group-row' + (isOpen?' open':'');
    tr.innerHTML = `<td><span class="catname"><span class="arrow${isOpen?' open':''}"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${label}</span></span></td>` +
      `<td class="num">${fmt(group.totPlan)}</td>` +
      numDiffCell(group.totActual, group.totPlan, totalColorClass) +
      forecastCell(group.totForecast, group.totPlan);
    tr.addEventListener('click', ()=>{
      if (openGroups.has(kind)) openGroups.delete(kind); else openGroups.add(kind);
      renderMid();
    });
    return tr;
  }

  tbody.appendChild(groupHeaderRow('income', 'Income', incomeGroup, 'group-total-income'));
  if (openGroups.has('income')){
    if (incomeGroup.rows.length === 0){
      tbody.appendChild(emptyGroupRow('No income categories loaded yet.', colCount));
    } else {
      incomeGroup.rows.forEach(row=>tbody.appendChild(row));
    }
  }
  tbody.appendChild(groupGapRow(colCount));

  tbody.appendChild(groupHeaderRow('expenses', 'Spending', spendingGroup, 'group-total-spending'));
  if (openGroups.has('expenses')){
    if (spendingGroup.rows.length === 0){
      tbody.appendChild(emptyGroupRow('No expense categories loaded yet.', colCount));
    } else {
      spendingGroup.rows.forEach(row=>tbody.appendChild(row));
    }
  }

  return table;
}

/* ---- Search results (flat, all transactions) ---- */
// ---- Transactions page — a tab (not a search-triggered overlay): it
// defaults to showing every transaction, with the search field acting as
// a live filter on that list. The title bar (with the search input) is
// built once per visit to the tab; typing only rebuilds the results body
// below it via refresh(), so the input never gets torn down and re-focused
// mid-keystroke the way a full renderMid() would.
function renderTransactionsPage(mid){
  const titleBar = document.createElement('div');
  titleBar.className = 'mid-title transactions-toolbar';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = 'Transactions';
  titleBar.appendChild(titleSpan);

  const searchWrap = document.createElement('div');
  searchWrap.className = 'search-wrap';
  searchWrap.innerHTML = `<img class="search-icon" src="icons/search.svg" alt="">`;
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'search-input';
  input.placeholder = 'Search transactions…';
  input.value = searchQuery;
  searchWrap.appendChild(input);
  titleBar.appendChild(searchWrap);
  mid.appendChild(titleBar);

  const body = document.createElement('div');
  body.className = 'mid-body';
  mid.appendChild(body);

  function refresh(){
    body.innerHTML = '';
    body.appendChild(renderTransactionsBody(refresh));
  }
  input.addEventListener('input', (e)=>{
    searchQuery = e.target.value.trim();
    refresh();
  });
  refresh();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function renderTransactionsBody(onSortChange){
  const wrap = document.createDocumentFragment();
  const heading = document.createElement('div');
  heading.className = 'search-heading';
  const rows = filteredSearchTxns();
  heading.innerHTML = searchQuery
    ? `<b>${rows.length}</b> transaction${rows.length===1?'':'s'} matching "<b>${escapeHTML(searchQuery)}</b>"`
    : `<b>${rows.length}</b> transaction${rows.length===1?'':'s'}`;
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
      onSortChange();
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
   active it fully replaces the mid/right panel content. The table itself
   mirrors the read-only Year table's Net/Income/Spending layout (see
   renderYearTable) so the two always look and align the same way, but
   every category/subcategory row is editable in place and a category's
   chevron is always visible (not hover-only) since, while editing, you
   need the expand affordance to always be legible. Selecting a
   subcategory row shows its line items — the only place amounts/frequency
   are actually edited — in the right panel instead of inline, since the
   month-by-month table has no room for that; see renderBudgetItemRow.
   Renaming/adding/removing a category or subcategory always rebuilds the
   whole table (renderMid()), since row DOM has to change shape anyway;
   editing a line item's amount/frequency instead patches just the
   affected cells (see refreshBudgetLiveTotals) so typing doesn't lose
   focus on every keystroke.
   ============================================================ */
function renderBudgetEditor(mid){
  const header = document.createElement('div');
  header.className = 'budget-editor-header';
  const hasSaved = Object.keys(BUDGETS_RAW.Expenses||{}).length || Object.keys(BUDGETS_RAW.Income||{}).length;
  const title = document.createElement('div');
  title.className = 'budget-editor-title';
  title.textContent = hasSaved ? 'Edit Budget' : 'Create Budget';
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'budget-editor-actions';

  // Import CSV sits beside Cancel/Save as a third header action rather than
  // its own toolbar row — it's a starting-point convenience for the draft,
  // not a distinct step in the Cancel/Save flow.
  const importLabel = document.createElement('label');
  importLabel.className = 'file-btn ghost';
  importLabel.textContent = 'Import CSV';
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
  actions.appendChild(importLabel);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'file-btn ghost';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', ()=>{
    if (confirm('Discard changes to this budget?')) cancelBudgetEdit();
  });
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'file-btn primary';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save budget';
  saveBtn.addEventListener('click', saveBudgetEdit);
  actions.appendChild(saveBtn);

  header.appendChild(actions);
  mid.appendChild(header);

  const body = document.createElement('div');
  body.className = 'budget-editor-body';
  body.appendChild(wrapScroll(renderBudgetTable()));
  mid.appendChild(body);
}

// Builds the name+delete <td> shared by category and subcategory rows —
// an editable name input (blends into plain text at rest, same as the old
// card editor's .budget-name-input) plus a delete icon-button that only
// takes up space on row hover (row-delete-wrap), so it never disturbs the
// column's fixed width. `arrow` is the category row's always-visible
// chevron element, or null for a (leaf) subcategory row.
function budgetNameCell({ value, placeholder, isSub, arrow, onNameInput, onDelete, deleteTitle, hideDelete }){
  const td = document.createElement('td');
  const catname = document.createElement('span');
  catname.className = 'catname';
  if (arrow) catname.appendChild(arrow);
  const nameInput = document.createElement('input');
  nameInput.className = 'budget-name-input' + (isSub ? ' sub' : '');
  nameInput.placeholder = placeholder;
  nameInput.value = value;
  nameInput.addEventListener('click', e=>e.stopPropagation());
  nameInput.addEventListener('input', onNameInput);
  catname.appendChild(nameInput);
  // A not-yet-real pending row (see buildGroup's trailing sub-row) has
  // nothing to delete yet, so it skips the delete button entirely rather
  // than wiring one up to a no-op.
  if (!hideDelete){
    const delWrap = document.createElement('span');
    delWrap.className = 'row-delete-wrap';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn';
    delBtn.title = deleteTitle;
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e)=>{ e.stopPropagation(); onDelete(); });
    delWrap.appendChild(delBtn);
    catname.appendChild(delWrap);
  }
  td.appendChild(catname);
  return { td, nameInput };
}

function budgetNumCells(monthly, total){
  const cells = monthly.map(v=>`<td class="num">${fmt(v)}</td>`).join('');
  return cells + `<td class="num">${fmt(total)}</td>`;
}

// Finds the category/subcategory name input `el` belongs to (real or
// pending, category-level or subcategory-level) and returns a function
// that re-locates the *equivalent* input in a freshly-rendered mid panel
// — used to restore focus onto a click target that a pending row's commit
// is about to rebuild out from under the browser's own pending focus
// change. Returns null for anything else (a button, an input elsewhere in
// the app, or nothing at all), which just leaves that focus change alone.
function locateBudgetNameInput(el){
  if (!el || !el.classList || !el.classList.contains('budget-name-input')) return null;
  const tr = el.closest('tr');
  if (!tr) return null;
  const pending = tr.classList.contains('pending');
  if (tr.classList.contains('sub-row')){
    const catId = tr.dataset.catId;
    const sel = pending
      ? `tr.sub-row.pending[data-cat-id="${catId}"] .budget-name-input`
      : `tr.sub-row[data-sub-id="${tr.dataset.subId}"] .budget-name-input`;
    return (root)=>root.querySelector(sel);
  }
  if (tr.classList.contains('cat-row')){
    const sel = pending
      ? `tr.cat-row.pending[data-kind="${tr.dataset.kind}"] .budget-name-input`
      : `tr.cat-row[data-cat-id="${tr.dataset.catId}"]:not(.pending) .budget-name-input`;
    return (root)=>root.querySelector(sel);
  }
  return null;
}

// Floating suggestion list for a pending category/subcategory name input
// — appended to <body> and positioned with `position:fixed` over the
// input's own on-screen rect (a "portal", same reasoning as the add-item
// modal being body-appended rather than nested in the panel: .table-
// scroll's overflow — see its own comment — would otherwise clip a
// dropdown taller than the remaining visible table area). Shows whatever
// `getSuggestions()` currently returns on focus, re-filtered by the
// input's own value (case-insensitive substring) on every keystroke;
// picking one calls `onPick(name)` rather than writing the value here
// directly, so the caller (bindPendingCommit) can commit it exactly like
// an Enter/Tab keypress would. Clicking an option is a mousedown on a
// plain, non-focusable div — without preventDefault, the browser would
// still blur the input first (committing whatever partial text is
// currently typed, not the option chosen), so that default is
// suppressed and the input never actually loses focus.
function bindTypeahead(input, getSuggestions){
  let listEl = null;
  function close(){
    if (listEl){ listEl.remove(); listEl = null; }
  }
  function render(){
    const q = input.value.trim().toLowerCase();
    const options = getSuggestions().filter(name=>name.toLowerCase().includes(q));
    if (!options.length){ close(); return; }
    if (!listEl){
      listEl = document.createElement('div');
      listEl.className = 'typeahead-list';
      document.body.appendChild(listEl);
    } else {
      listEl.innerHTML = '';
    }
    options.forEach(name=>{
      const opt = document.createElement('div');
      opt.className = 'typeahead-option';
      opt.textContent = name;
      opt.addEventListener('mousedown', (e)=>{
        e.preventDefault();
        close();
        input.dispatchEvent(new CustomEvent('typeahead-pick', { detail: name }));
      });
      listEl.appendChild(opt);
    });
    const r = input.getBoundingClientRect();
    // Left unset otherwise, the list shrink-to-fits its content up to a
    // 24rem cap (see .typeahead-list) rather than matching the (much
    // narrower) input it hangs off of. Only tightened here when even that
    // wouldn't fit before the viewport's right edge.
    listEl.style.left = r.left + 'px';
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const viewportMax = document.documentElement.clientWidth - r.left - 8;
    listEl.style.maxWidth = Math.min(24 * remPx, viewportMax) + 'px';

    // Vertical placement: below the input by default (matching its own
    // CSS max-height of 180px), but flipped above it when the input sits
    // too close to the bottom of the viewport to fit that — e.g. a
    // pending row near the bottom of the visible table — and there's more
    // room above than below. Either way the list's own max-height is
    // capped to whatever room that side actually has, so it's scrollable
    // rather than spilling off-screen if a lot of options match.
    const gap = 4, preferredHeight = 180, minHeight = 60;
    const spaceBelow = window.innerHeight - r.bottom - gap;
    const spaceAbove = r.top - gap;
    const openAbove = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    if (openAbove){
      listEl.style.top = 'auto';
      listEl.style.bottom = (window.innerHeight - r.top + gap) + 'px';
      listEl.style.maxHeight = Math.max(minHeight, Math.min(preferredHeight, spaceAbove)) + 'px';
    } else {
      listEl.style.bottom = 'auto';
      listEl.style.top = (r.bottom + gap) + 'px';
      listEl.style.maxHeight = Math.max(minHeight, Math.min(preferredHeight, spaceBelow)) + 'px';
    }
  }
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', close);
}

// Wires a pending row's name input so committing it doesn't depend on
// any one specific key — Enter, Tab, or simply clicking/tabbing away
// (blur) all commit it, as long as there's a non-blank name typed;
// leaving it blank just lets focus move on normally, nothing committed.
// `commit(name)` does the actual draft mutation (push the new category/
// subcategory, select it if applicable) and returns the id of the
// category whose pending row should get focus next — but that auto-focus
// only actually happens for Enter/Tab, matching the existing keyboard-
// driven flow of rapid sequential entry. A blur commits the row without
// forcing focus anywhere new — *unless* the blur happened because the
// user clicked straight into another category/subcategory name field, in
// which case that field would normally receive focus next regardless, and
// our rebuild of the table (which replaces it with an equivalent new
// element) shouldn't be what stops that from happening. Enter/Tab and the
// resulting blur (rebuilding the DOM removes this input) can both fire
// for the same keypress, so `committed` makes sure the commit itself only
// happens once either way. `getSuggestions`, if given, adds a typeahead
// of category/subcategory names loaded transactions already establish
// that aren't in the budget yet (see bindTypeahead) — picking one commits
// it immediately, same as pressing Enter after typing it out by hand.
function bindPendingCommit(input, commit, getSuggestions){
  let committed = false;
  function tryCommit(focusNext, refocus){
    if (committed) return;
    const name = input.value;
    if (!name.trim()) return;
    committed = true;
    const catId = commit(name);
    if (focusNext) budgetFocusPending = { catId };
    renderMid(); renderRight();
    if (!focusNext && refocus){
      const el = refocus(document.getElementById('midPanel'));
      if (el) el.focus();
    }
  }
  input.addEventListener('keydown', (e)=>{
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    // Only preempt the key's default action (Enter's implicit submit,
    // Tab's focus-to-next-element) when there's actually something to
    // commit — a blank pending row lets Tab fall through to normal
    // browser focus navigation instead.
    if (input.value.trim()) e.preventDefault();
    tryCommit(true);
  });
  input.addEventListener('blur', (e)=>tryCommit(false, locateBudgetNameInput(e.relatedTarget)));
  if (getSuggestions){
    bindTypeahead(input, getSuggestions);
    input.addEventListener('typeahead-pick', (e)=>{
      input.value = e.detail;
      tryCommit(true);
    });
  }
}

// Trailing pending category row — sits at the bottom of a whole Income/
// Spending group, styled and laid out exactly like a real (but blank)
// category row, complete with the always-visible chevron for alignment.
// Same mechanism as buildGroup's pending subcategory row: it has no id of
// its own and isn't in the draft yet; typing into it just types, and
// pressing Enter is what commits it as a real top-level category (added
// to `list`, opened). Focus then lands in *that* category's own pending
// subcategory row (see budgetFocusPending) rather than back on this
// group's next pending category row — naming a category flows straight
// into naming its first subcategory. Unlike the nested pending row,
// there's no "named" gating here — nothing above a top-level category to
// withhold it on.
function buildPendingCatRow(kind, list){
  const label = `New ${kind} category`;
  const tr = document.createElement('tr');
  tr.className = 'cat-row nested pending';
  tr.dataset.kind = kind; // lets locateBudgetNameInput re-find this row's
                          // input by group after a blur-triggered re-render
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = `<img src="icons/chevron-right.svg" alt="">`;
  const { td, nameInput } = budgetNameCell({
    value: '', placeholder: label, arrow, hideDelete: true,
    onNameInput: ()=>{},
  });
  bindPendingCommit(nameInput, (name)=>{
    const cat = { id: nextBudgetId(), name, subcategories: [] };
    list.push(cat);
    budgetOpenCats.add(cat.id);
    return cat.id; // Enter/Tab land focus in this category's own pending
                   // subcategory row — naming a category is almost always
                   // immediately followed by naming its first subcategory.
  }, ()=>{
    // Transaction-established categories of this Type not already in the
    // draft — same source draftCategoriesFor merges in, just without the
    // categories the draft already has (those don't need suggesting).
    const txCats = kind === 'income' ? DATA.incomeSubcats : DATA.categories;
    const existingNames = new Set(list.map(c=>c.name));
    return txCats.map(c=>c.name).filter(name=>!existingNames.has(name));
  });
  tr.appendChild(td);
  tr.insertAdjacentHTML('beforeend', budgetNumCells(new Array(12).fill(0), 0));
  return tr;
}

/* ---- Budget editor table (Net/Income/Spending, editable) ---- */
function renderBudgetTable(){
  const table = document.createElement('table');
  table.className = 'ledger ledger-year ledger-grouped budget-editor-ledger';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th></th>${MONTHS.map(m=>`<th>${m}</th>`).join('')}<th>Total</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  // Builds one Income or Spending group's rows: a bold category row per
  // draft category (always-visible chevron, editable name, delete-on-
  // hover), its subcategory rows nested underneath when open (selectable —
  // clicking one shows its line items in the right panel), a trailing
  // blank/pending subcategory row that turns into a real one as soon as
  // you start typing a name into it (see the pending row below — no
  // separate "add subcategory" button to click first), and monthly/grand
  // totals rolled up from budgetCatDisplayMonthly regardless of whether
  // the category is currently open.
  function buildGroup(kind, list){
    const monthTotals = new Array(12).fill(0);
    let grandTotal = 0;
    const rows = [];
    const label = kind === 'income' ? 'Income source name' : 'Category name';

    list.forEach(cat=>{
      const monthly = budgetCatDisplayMonthly(cat, kind);
      monthly.forEach((v,i)=>monthTotals[i]+=v);
      const total = monthly.reduce((a,b)=>a+b,0);
      grandTotal += total;

      const isOpen = budgetOpenCats.has(cat.id);
      const tr = document.createElement('tr');
      tr.className = 'cat-row nested';
      tr.dataset.catId = cat.id;
      const arrow = document.createElement('span');
      arrow.className = 'arrow' + (isOpen ? ' open' : '');
      arrow.innerHTML = `<img src="icons/chevron-right.svg" alt="">`;
      const { td } = budgetNameCell({
        value: cat.name, placeholder: label, arrow,
        onNameInput: (e)=>{
          cat.name = e.target.value;
          // Live-update the pending subcategory row's visibility and
          // "New {category}" placeholder as the category is named/renamed,
          // without a full renderMid() (which would drop focus out of this
          // input on every keystroke).
          const pendingRow = tbody.querySelector(`tr.sub-row.pending[data-cat-id="${cat.id}"]`);
          if (pendingRow){
            pendingRow.classList.toggle('named', !!cat.name.trim());
            const pendingInput = pendingRow.querySelector('.budget-name-input');
            if (pendingInput) pendingInput.placeholder = `New ${cat.name.trim()}`;
          }
        },
        onDelete: ()=>{
          const kindLabel = kind === 'income' ? 'income source' : 'category';
          if (!confirm(`Delete ${kindLabel} "${cat.name || '(unnamed)'}" and all its subcategories?`)) return;
          if (kind === 'income') budgetDraft.income = budgetDraft.income.filter(c=>c.id!==cat.id);
          else budgetDraft.expenses = budgetDraft.expenses.filter(c=>c.id!==cat.id);
          if (budgetSelection && budgetSelection.catId === cat.id) budgetSelection = null;
          renderMid(); renderRight();
        },
        deleteTitle: kind === 'income' ? 'Delete income source' : 'Delete category',
      });
      tr.appendChild(td);
      tr.insertAdjacentHTML('beforeend', budgetNumCells(monthly, total));
      tr.addEventListener('click', ()=>{
        if (budgetOpenCats.has(cat.id)) budgetOpenCats.delete(cat.id); else budgetOpenCats.add(cat.id);
        renderMid();
      });
      rows.push(tr);

      cat.subcategories.forEach(sub=>{
        const subMonthly = budgetSubDisplayMonthly(sub, kind);
        const subTotal = subMonthly.reduce((a,b)=>a+b,0);
        const isSel = !!(budgetSelection && budgetSelection.kind===kind && budgetSelection.subId===sub.id);
        const sr = document.createElement('tr');
        sr.className = 'sub-row' + (isOpen ? ' open' : '') + (isSel ? ' selected' : '');
        sr.dataset.subId = sub.id;
        const { td: subTd } = budgetNameCell({
          value: sub.name, placeholder: 'Subcategory name', isSub: true,
          onNameInput: (e)=>{ sub.name = e.target.value; },
          onDelete: ()=>{
            if (!confirm(`Delete "${sub.name || '(unnamed)'}"?`)) return;
            cat.subcategories = cat.subcategories.filter(s=>s.id!==sub.id);
            if (budgetSelection && budgetSelection.subId === sub.id) budgetSelection = null;
            renderMid(); renderRight();
          },
          deleteTitle: 'Delete subcategory',
        });
        sr.appendChild(subTd);
        sr.insertAdjacentHTML('beforeend', budgetNumCells(subMonthly, subTotal));
        sr.addEventListener('click', (e)=>{
          e.stopPropagation();
          selectBudgetSub({ kind, catId: cat.id, subId: sub.id });
        });
        rows.push(sr);
      });

      // Trailing pending row: looks and sits exactly like a subcategory
      // row, but isn't one yet — it has no id of its own and isn't in
      // cat.subcategories. Typing into it just types, same as any text
      // input; pressing Enter is what commits it (added to the draft as a
      // real subcategory), at which point a fresh pending row takes its
      // place and gets focus, ready for the next one. A new pending row
      // never appears before that — there's only ever one open "build"
      // slot per category at a time. Hidden until the category itself has
      // a name, same reasoning as the old add-subcategory button: no
      // ambiguous, unnamed category with subcategories already hanging
      // off it.
      const pendingRow = document.createElement('tr');
      pendingRow.className = 'sub-row pending' + (isOpen ? ' open' : '') + (cat.name.trim() ? ' named' : '');
      pendingRow.dataset.catId = cat.id;
      const { td: pendingTd, nameInput: pendingInput } = budgetNameCell({
        value: '', placeholder: `New ${cat.name.trim()}`, isSub: true, hideDelete: true,
        onNameInput: ()=>{},
      });
      bindPendingCommit(pendingInput, (name)=>{
        const sub = { id: nextBudgetId(), name, items: [] };
        cat.subcategories.push(sub);
        // Select the newly-committed subcategory (as if it had been
        // clicked) so its line items are right there in the right panel
        // to start filling in — this happens regardless of how the row
        // was committed, unlike the Enter/Tab-only focus-forwarding below.
        budgetSelection = { kind, catId: cat.id, subId: sub.id };
        return cat.id; // Enter/Tab land focus in the next pending row for
                        // this same category, ready for the next one.
      }, ()=>{
        // Transaction-established subcategories under a transaction
        // category matching this one *by name* (there's nothing else to
        // key off — this draft category may not even be transaction-
        // derived at all), minus whatever's already in the draft here.
        const txCats = kind === 'income' ? DATA.incomeSubcats : DATA.categories;
        const txCat = txCats.find(c=>c.name===cat.name);
        if (!txCat) return [];
        const existingNames = new Set(cat.subcategories.map(s=>s.name));
        return txCat.subcategories.map(s=>s.name).filter(name=>!existingNames.has(name));
      });
      pendingRow.appendChild(pendingTd);
      pendingRow.insertAdjacentHTML('beforeend', budgetNumCells(new Array(12).fill(0), 0));
      rows.push(pendingRow);
    });

    return { monthTotals, grandTotal, rows };
  }

  const incomeGroup = buildGroup('income', budgetDraft.income);
  const spendingGroup = buildGroup('expense', budgetDraft.expenses);

  // Net row — same markup/CSS as the read-only Year table's, permanently
  // non-interactive and non-collapsible.
  const netMonthTotals = incomeGroup.monthTotals.map((v,i)=>v - spendingGroup.monthTotals[i]);
  const netGrandTotal = incomeGroup.grandTotal - spendingGroup.grandTotal;
  const netRow = document.createElement('tr');
  netRow.className = 'net-row';
  netRow.innerHTML = `<td><span class="catname"><span class="arrow"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">Net</span></span></td>` +
    netMonthTotals.map((v,i)=>`<td class="num ${signCls(v)}">${fmt(v)}</td>`).join('') +
    `<td class="num ${signCls(netGrandTotal)}">${fmt(netGrandTotal)}</td>`;
  tbody.appendChild(netRow);
  tbody.appendChild(groupGapRow(14));

  // Income/Spending header rows — bold and permanently expanded (no
  // collapse chevron at all while editing: budget-group-row zeroes the
  // arrow out exactly like the Net row, rather than hiding it until hover
  // like the read-only table's group-row).
  function groupHeaderRow(label, group, totalColorClass){
    const tr = document.createElement('tr');
    tr.className = 'budget-group-row';
    tr.innerHTML = `<td><span class="catname"><span class="arrow"><img src="icons/chevron-right.svg" alt=""></span><span class="cell-label">${label}</span></span></td>` +
      group.monthTotals.map(v=>`<td class="num">${fmt(v)}</td>`).join('') +
      `<td class="num ${totalColorClass}">${fmt(group.grandTotal)}</td>`;
    return tr;
  }

  tbody.appendChild(groupHeaderRow('Income', incomeGroup, 'group-total-income'));
  incomeGroup.rows.forEach(row=>tbody.appendChild(row));
  tbody.appendChild(buildPendingCatRow('income', budgetDraft.income));
  tbody.appendChild(groupGapRow(14));

  tbody.appendChild(groupHeaderRow('Spending', spendingGroup, 'group-total-spending'));
  spendingGroup.rows.forEach(row=>tbody.appendChild(row));
  tbody.appendChild(buildPendingCatRow('expense', budgetDraft.expenses));

  return table;
}

function selectBudgetSub(sel){
  if (budgetSelection && budgetSelection.kind===sel.kind && budgetSelection.catId===sel.catId && budgetSelection.subId===sel.subId){
    budgetSelection = null;
  } else {
    budgetSelection = sel;
  }
  renderMid();
  renderRight();
}

// Patches just the cells whose numbers can have changed after an item's
// amount/frequency edit (the selected subcategory's own row, its parent
// category row, that group's header row, and the Net row) — see the
// renderBudgetEditor comment for why this avoids a full renderMid().
function updateLedgerRowCells(tr, monthly, total){
  if (!tr) return;
  const cells = tr.querySelectorAll('td.num');
  monthly.forEach((v,i)=>{ if (cells[i]) cells[i].textContent = fmt(v); });
  const totalCell = tr.querySelector('td:last-child');
  if (totalCell) totalCell.textContent = fmt(total);
}
function refreshBudgetLiveTotals(kind, cat, sub){
  const table = document.querySelector('.budget-editor-ledger');
  if (!table) return;

  const subMonthly = budgetSubDisplayMonthly(sub, kind);
  updateLedgerRowCells(table.querySelector(`tr.sub-row[data-sub-id="${sub.id}"]`), subMonthly, subMonthly.reduce((a,b)=>a+b,0));

  const catMonthly = budgetCatDisplayMonthly(cat, kind);
  updateLedgerRowCells(table.querySelector(`tr.cat-row[data-cat-id="${cat.id}"]`), catMonthly, catMonthly.reduce((a,b)=>a+b,0));

  const incomeMonthly = budgetGroupDisplayMonthly(budgetDraft.income, 'income');
  const expenseMonthly = budgetGroupDisplayMonthly(budgetDraft.expenses, 'expense');
  const groupRows = table.querySelectorAll('tr.budget-group-row');
  const groupMonthly = kind === 'income' ? incomeMonthly : expenseMonthly;
  updateLedgerRowCells(groupRows[kind==='income'?0:1], groupMonthly, groupMonthly.reduce((a,b)=>a+b,0));

  const netMonthly = incomeMonthly.map((v,i)=>v - expenseMonthly[i]);
  const netTotal = netMonthly.reduce((a,b)=>a+b,0);
  const netRow = table.querySelector('tr.net-row');
  if (netRow){
    const cells = netRow.querySelectorAll('td.num');
    netMonthly.forEach((v,i)=>{
      if (!cells[i]) return;
      cells[i].textContent = fmt(v);
      cells[i].className = 'num ' + signCls(v);
    });
    const totalCell = netRow.querySelector('td:last-child');
    if (totalCell){ totalCell.textContent = fmt(netTotal); totalCell.className = 'num ' + signCls(netTotal); }
  }
}

// Editable line-item row — label/frequency/amount inputs plus a remove
// button. Lives only in the right panel now (see renderBudgetSelectionPanel
// below), for whichever subcategory is currently selected in the table.
function renderBudgetItemRow(item, sub, cat, kind){
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
  // Items reaching this row always come from budgetDraft, where the legacy
  // freq:"daily" value has already been normalized into freq:"monthly" +
  // amountType:"perDiem" (see budgetsRawToDraft) — so "Daily" itself is no
  // longer offered here, only via the Amount Type select below.
  const freqOptions = [['monthly','Monthly'], ...MONTHS_FULL.map((m,i)=>[MONTH_ABBR[i], m+' (once)'])];
  const curFreq = (item.freq||'monthly').toLowerCase();
  freqOptions.forEach(([val,label])=>{
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (curFreq === val) opt.selected = true;
    freqSelect.appendChild(opt);
  });
  row.appendChild(freqSelect);

  const isArrayAmount = Array.isArray(item.amount) && curFreq === 'monthly';
  // Amount Type has no meaning for an explicit 12-value array (already a
  // literal total per month — see resolveLineItem), so it's skipped
  // entirely alongside the amount input in that case.
  if (!isArrayAmount){
    const amountTypeSelect = document.createElement('select');
    amountTypeSelect.className = 'budget-item-freq';
    const amountTypeOptions = [['monthly','Per Month'],['perDiem','Per Diem']];
    const curAmountType = item.amountType === 'perDiem' ? 'perDiem' : 'monthly';
    amountTypeOptions.forEach(([val,label])=>{
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      if (curAmountType === val) opt.selected = true;
      amountTypeSelect.appendChild(opt);
    });
    amountTypeSelect.addEventListener('change', ()=>{
      item.amountType = amountTypeSelect.value;
      onChanged();
    });
    row.appendChild(amountTypeSelect);
  }

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
    const displayVal = kind==='expense' ? Math.abs(Number(item.amount)||0) : (Number(item.amount)||0);
    amountInput.value = displayVal || '';
    amountInput.placeholder = '0';
    row.appendChild(amountInput);
  }

  function onChanged(){
    if (budgetRightSubTotalEl){
      const v = budgetSubYearTotal(sub);
      budgetRightSubTotalEl.textContent = fmtSigned(v);
      budgetRightSubTotalEl.className = 'right-total-value num ' + signCls(v);
    }
    refreshBudgetLiveTotals(kind, cat, sub);
    updateBudgetRightSummary();
  }
  freqSelect.addEventListener('change', ()=>{
    item.freq = freqSelect.value;
    onChanged();
  });
  if (amountInput){
    amountInput.addEventListener('input', ()=>{
      const raw = parseFloat(amountInput.value);
      const v = isNaN(raw) ? 0 : raw;
      item.amount = kind==='expense' ? -Math.abs(v) : Math.abs(v);
      onChanged();
    });
  }

  // Links this item to specific actual transaction descriptions, so the
  // Forecast pill can treat it as a spending cap (matched actual vs.
  // planned) for the current month instead of falling back to the whole
  // subcategory's whichever's-bigger comparison — see resolveBudgets.
  // Expense-only (income's subcategories already correspond 1:1 with a
  // single transaction description — see transactionMatchesBudgetSlot —
  // so linking there would just offer one redundant option) and only for
  // a plain per-month amount (per diem items are always additive
  // regardless of any specific transaction, and an explicit 12-value
  // array has no single "planned" figure to compare against).
  if (kind === 'expense' && !isArrayAmount && !isPerDiemItem(item)){
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'budget-item-link-btn';
    const syncLinkBtn = () => {
      const n = item.linkedDescriptions ? item.linkedDescriptions.length : 0;
      linkBtn.textContent = n ? `Linked (${n})` : 'Link';
      linkBtn.classList.toggle('linked', n > 0);
    };
    syncLinkBtn();
    linkBtn.addEventListener('click', ()=>{
      openLinkTransactionsModal(item, cat, sub, kind, syncLinkBtn);
    });
    row.appendChild(linkBtn);
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

// Every distinct actual transaction description on record for a given
// category/subcategory, across every month/year currently loaded — not
// just the current month, since a linked description should keep matching
// whatever month later becomes "current" as fresh CSVs get loaded.
function distinctDescriptionsFor(category, subcategory){
  const set = new Set();
  DATA.transactions.forEach(t=>{
    if (t.type==='Expenses' && t.category===category && t.subcategory===subcategory) set.add(t.description);
  });
  return [...set].sort((a,b)=>a.localeCompare(b));
}

// Every description already linked to some OTHER item in the draft (any
// category/subcategory) — excluded from a picker so the same actual
// dollars can never be claimed by two line items at once.
function claimedDescriptionsExcept(kind, exceptItemId){
  const list = kind === 'income' ? budgetDraft.income : budgetDraft.expenses;
  const set = new Set();
  list.forEach(c=>c.subcategories.forEach(s=>s.items.forEach(it=>{
    if (it.id === exceptItemId) return;
    (it.linkedDescriptions||[]).forEach(d=>set.add(d));
  })));
  return set;
}

// Modal for choosing which actual transaction descriptions (in this
// item's own category/subcategory) count as this line item's matched
// actual spend — see resolveBudgets. onSaved is called after a successful
// save so the caller can refresh just its own trigger button rather than
// re-rendering the whole editor.
function openLinkTransactionsModal(item, cat, sub, kind, onSaved){
  const available = distinctDescriptionsFor(cat.name, sub.name);
  const claimedElsewhere = claimedDescriptionsExcept(kind, item.id);
  const pickable = available.filter(d=>!claimedElsewhere.has(d));
  const currentlyLinked = new Set(item.linkedDescriptions || []);

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.addEventListener('click', e=>e.stopPropagation());
  scrim.appendChild(dialog);

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Link Transactions';
  dialog.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'modal-hint';
  hint.textContent = `Transactions in ${cat.name} › ${sub.name} that count toward "${item.label || sub.name}".`;
  dialog.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'link-txn-list';
  if (pickable.length === 0){
    const empty = document.createElement('div');
    empty.className = 'link-txn-empty';
    empty.textContent = available.length === 0
      ? 'No transactions loaded yet for this category/subcategory.'
      : 'Every transaction description here is already linked to another line item.';
    list.appendChild(empty);
  } else {
    pickable.forEach(desc=>{
      const option = document.createElement('label');
      option.className = 'link-txn-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = desc;
      checkbox.checked = currentlyLinked.has(desc);
      const text = document.createElement('span');
      text.textContent = desc;
      option.appendChild(checkbox);
      option.appendChild(text);
      list.appendChild(option);
    });
  }
  dialog.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'add-plan-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'file-btn ghost';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'file-btn primary';
  saveBtn.textContent = 'Save';
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
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
  saveBtn.addEventListener('click', ()=>{
    item.linkedDescriptions = [...list.querySelectorAll('input:checked')].map(el=>el.value);
    close();
    onSaved();
  });
  document.addEventListener('keydown', onKeydown);

  document.body.appendChild(scrim);
}

// Default right-panel content while editing a budget and nothing is
// selected in the table — overall Income/Expenses/Net draft totals, live-
// updated (via updateBudgetRightSummary) as items change elsewhere.
function renderBudgetSummaryPanel(right){
  const t = draftAnnualTotals(budgetDraft);
  right.innerHTML = `
    <div class="right-header">
      <div class="right-eyebrow">Annual Plan Preview</div>
      <div class="right-title">Budget draft</div>
    </div>
    <div class="right-body">
      <div class="right-total-row"><span class="right-total-label">Income</span><span class="right-total-value num" id="budgetSumIncome">${fmt(t.incomeTotal)}</span></div>
      <div class="right-total-row"><span class="right-total-label">Expenses</span><span class="right-total-value num" id="budgetSumExpenses">${fmt(t.expenseTotal)}</span></div>
      <div class="right-total-row"><span class="right-total-label">Net</span><span class="right-total-value num ${signCls(t.net)}" id="budgetSumNet">${fmtSigned(t.net)}</span></div>
      <div class="right-empty">Select a subcategory to edit its line items. Nothing is saved until you click <b>Save budget</b>.</div>
    </div>
  `;
  budgetSummaryEls = {
    income: document.getElementById('budgetSumIncome'),
    expenses: document.getElementById('budgetSumExpenses'),
    net: document.getElementById('budgetSumNet'),
  };
}

// Right-panel content while a subcategory is selected in the budget
// editor's table — its annual total plus its editable line items (see
// renderBudgetItemRow), with an add-line-item button at the bottom (same
// "+ Add income"/"+ Add expense" wording as the table's own add rows)
// that opens the shared add-item modal — see openAddDraftItemModal.
function renderBudgetSelectionPanel(right){
  const { kind, catId, subId } = budgetSelection;
  const list = kind === 'income' ? budgetDraft.income : budgetDraft.expenses;
  const cat = list.find(c=>c.id===catId);
  const sub = cat && cat.subcategories.find(s=>s.id===subId);
  if (!cat || !sub){
    budgetSelection = null;
    renderBudgetSummaryPanel(right);
    return;
  }

  const header = document.createElement('div');
  header.className = 'right-header';
  header.innerHTML = `<div class="right-eyebrow">${kind==='income'?'Income':'Spending'}</div><div class="right-title">${escapeHTML(sub.name || '(unnamed subcategory)')}</div>`;
  right.appendChild(header);

  const body = document.createElement('div');
  body.className = 'right-body';
  right.appendChild(body);

  const totalVal = budgetSubYearTotal(sub);
  const totalRow = document.createElement('div');
  totalRow.className = 'right-total-row';
  totalRow.innerHTML = `<span class="right-total-label">${DATA.year} Budget</span><span class="right-total-value num ${signCls(totalVal)}" id="budgetSubTotalEl">${fmtSigned(totalVal)}</span>`;
  body.appendChild(totalRow);
  budgetRightSubTotalEl = totalRow.querySelector('#budgetSubTotalEl');

  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'budget-items';
  sub.items.forEach(item=>{
    itemsWrap.appendChild(renderBudgetItemRow(item, sub, cat, kind));
  });
  body.appendChild(itemsWrap);

  const addItemBtn = document.createElement('button');
  addItemBtn.type = 'button';
  addItemBtn.className = 'add-item-btn';
  addItemBtn.textContent = kind === 'income' ? '+ Add income' : '+ Add expense';
  // Opens the shared add-item modal (see openAddDraftItemModal) rather
  // than dropping a blank, inline-edited row straight into the table.
  addItemBtn.addEventListener('click', openAddDraftItemModal);
  body.appendChild(addItemBtn);
}

/* ============================================================
   RIGHT PANEL
   ============================================================ */
function renderRight(){
  const right = document.getElementById('rightPanel');
  right.innerHTML = '';
  // .right-header's height varies (a long subcategory name can wrap to a
  // second line), unlike the mid panel's fixed-height .mid-title, so any
  // sticky table thead underneath it (table.txn-list, see styles.css)
  // can't just use a constant offset — measure the header actually
  // rendered below and publish it as a CSS var for that thead's `top`.
  // Scheduled for next frame so it runs after every branch below has
  // finished mutating `right`, regardless of which one ran.
  requestAnimationFrame(()=>{
    const headerEl = right.querySelector('.right-header');
    right.style.setProperty('--right-sticky-top', (headerEl ? headerEl.getBoundingClientRect().height : 0) + 'px');
  });

  if (budgetEditMode){
    budgetRightSubTotalEl = null;
    if (budgetSelection) renderBudgetSelectionPanel(right);
    else renderBudgetSummaryPanel(right);
    return;
  }

  if (timeframe === 'transactions'){
    right.innerHTML = `<div class="right-body"><div class="right-empty">Browse and filter every transaction in the main panel.</div></div>`;
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
  } else {
    renderRightProjectedList(body);
  }
}

function getSelectedBudgetItems(){
  const group = selectedSub.kind === 'expense' ? BUDGETS.expenses : BUDGETS.income;
  const sub = (group[selectedSub.category]||{})[selectedSub.subcategory];
  return sub ? sub.items : [];
}

// Adds a new raw budget line item for whatever's selected in the budget
// editor — target is {kind,category,subcategory}, with the same
// category/subcategory-name-based find-or-create behavior the modal's own
// "+ New" option relies on. Writes into budgetDraft rather than straight
// into BUDGETS_RAW, since nothing in the editor is real until Save.
// Selects the (possibly newly-created) subcategory afterward, same as
// clicking it directly, so the added item is right there in the right
// panel.
function addDraftBudgetItem(target, freq, label, rawAmount, amountType){
  const amt = Math.abs(Number(rawAmount) || 0);
  if (amt === 0) return false;
  const list = target.kind === 'income' ? budgetDraft.income : budgetDraft.expenses;
  let cat = list.find(c=>c.name === target.category);
  if (!cat){
    cat = { id: nextBudgetId(), name: target.category, subcategories: [] };
    list.push(cat);
  }
  let sub = cat.subcategories.find(s=>s.name === target.subcategory);
  if (!sub){
    sub = { id: nextBudgetId(), name: target.subcategory, items: [] };
    cat.subcategories.push(sub);
  }
  sub.items.push({
    id: nextBudgetId(),
    freq,
    amountType: amountType === 'perDiem' ? 'perDiem' : 'monthly',
    linkedDescriptions: [],
    label: (label && label.trim()) || target.subcategory,
    amount: target.kind==='expense' ? -amt : amt,
  });
  budgetOpenCats.add(cat.id);
  budgetSelection = { kind: target.kind, catId: cat.id, subId: sub.id };
  return true;
}

// Category/subcategory options for the add-item modal's Type-dependent
// dropdowns while in the budget editor — the in-progress draft, merged
// with whatever categories/subcategories loaded transactions already
// establish (DATA.categories/DATA.incomeSubcats), same idea as
// mergedExpenseCategories/mergedIncomeSubcats (the read-only flow's
// equivalent, which merges the same transaction data with the committed
// BUDGETS instead of the draft) — so a category a transactions CSV
// already uses shows up here even before it's been added to this budget.
// The modal only reads `.name` off each entry, so both sources' shapes
// map down to the same plain {name, subcategories:[{name}]} regardless
// of what other fields they carry.
function draftCategoriesFor(kind){
  const txCats = kind === 'income' ? DATA.incomeSubcats : DATA.categories;
  const draftList = kind === 'income' ? budgetDraft.income : budgetDraft.expenses;
  const result = txCats.map(c=>({ name: c.name, subcategories: c.subcategories.map(s=>({ name: s.name })) }));
  const byName = new Map(result.map(c=>[c.name, c]));
  draftList.forEach(cat=>{
    let entry = byName.get(cat.name);
    if (!entry){
      entry = { name: cat.name, subcategories: [] };
      byName.set(cat.name, entry);
      result.push(entry);
    }
    const subByName = new Map(entry.subcategories.map(s=>[s.name, s]));
    cat.subcategories.forEach(sub=>{
      if (!subByName.has(sub.name)){
        const subEntry = { name: sub.name };
        entry.subcategories.push(subEntry);
        subByName.set(sub.name, subEntry);
      }
    });
  });
  return result;
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
  // Not wrapScroll()-wrapped like the mid panel's wide ledger tables — its
  // fixed Date/Description/Amount columns always fit the 360px right
  // panel, so it never needs its own horizontal scroll, and skipping the
  // wrapper means its sticky thead (see table.txn-list th in styles.css)
  // binds correctly to .right (the panel that actually scrolls) instead
  // of being stranded inside a redundant nested scroll container.
  container.appendChild(table);
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

// Centered modal (with a scrim behind it) for the budget editor's add-item
// form — built fresh and appended to <body> each time it opens, so it
// overlays the whole app rather than being scoped to the right panel.
// Opened via openAddDraftItemModal() (budget editor, subcategory selected),
// which writes into budgetDraft rather than straight into BUDGETS_RAW,
// since nothing here is real until Save (see addDraftBudgetItem).
// `opts`: { kind, category, subcategory } is the initial selection (all
// changeable in the form itself); `getCategories(kind)` returns the
// category/subcategory option list for a given Type; `onAdd(target, freq,
// label, amount, amountType)` performs the actual write into budgetDraft.
function openAddBudgetItemModal(opts){
  let currentKind = opts.kind;
  const categoriesFor = (k) => opts.getCategories(k);

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.addEventListener('click', e=>e.stopPropagation());
  scrim.appendChild(dialog);

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Add line item';
  dialog.appendChild(title);

  // Type — Income vs. Spending, at the top since it decides which
  // category/subcategory options the fields below offer.
  const typeField = document.createElement('div');
  typeField.className = 'modal-field';
  const typeLabel = document.createElement('div');
  typeLabel.className = 'modal-field-label';
  typeLabel.textContent = 'Type';
  const typeRow = document.createElement('div');
  typeRow.className = 'modal-type-pills';
  typeField.appendChild(typeLabel);
  typeField.appendChild(typeRow);
  dialog.appendChild(typeField);

  const incomeTypePill = document.createElement('button');
  incomeTypePill.type = 'button';
  incomeTypePill.className = 'pill';
  incomeTypePill.textContent = 'Income';
  const expenseTypePill = document.createElement('button');
  expenseTypePill.type = 'button';
  expenseTypePill.className = 'pill';
  expenseTypePill.textContent = 'Spending';
  typeRow.appendChild(incomeTypePill);
  typeRow.appendChild(expenseTypePill);
  const syncTypePills = () => {
    incomeTypePill.classList.toggle('active', currentKind==='income');
    expenseTypePill.classList.toggle('active', currentKind==='expense');
  };
  syncTypePills();

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
  catField.appendChild(catLabel);
  catField.appendChild(catRow);
  catRow.appendChild(wrapSelect(catSelect));
  catSubGroup.appendChild(catField);

  const catNewInput = makeNewNameInput('Category name');
  catRow.appendChild(catNewInput);
  const syncCatNew = () => { catNewInput.hidden = catSelect.value !== NEW_OPTION; };

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
      const cat = categoriesFor(currentKind).find(c=>c.name===catName);
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
  const populateCats = (preferredCat, preferredSub) => {
    catSelect.innerHTML = '';
    categoriesFor(currentKind).forEach(c=>{
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name;
      if (c.name === preferredCat) opt.selected = true;
      catSelect.appendChild(opt);
    });
    addNewOption(catSelect);
    syncCatNew();
    populateSubs(catSelect.value, preferredSub);
  };
  populateCats(opts.category, opts.subcategory);
  subSelect.addEventListener('change', syncSubNew);
  catSelect.addEventListener('change', () => {
    populateSubs(catSelect.value, null);
    syncCatNew();
  });
  function selectType(kind){
    if (kind === currentKind) return;
    currentKind = kind;
    syncTypePills();
    // Switching Type has no notion of a "same" category/subcategory to
    // carry over — Income and Spending are disjoint lists — so this
    // starts over at that Type's first category (or "+ New" if it has
    // none yet) rather than trying to preserve the old selection.
    populateCats(null, null);
  }
  incomeTypePill.addEventListener('click', ()=>selectType('income'));
  expenseTypePill.addEventListener('click', ()=>selectType('expense'));

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

  // Amount type — whether Amount above is a flat total for whichever
  // month(s) get picked below, or a per-day rate multiplied out by the
  // number of days in each of those months (see resolveLineItem and, for
  // the Forecast pill's current-month figure specifically,
  // itemCurrentMonthSplit).
  let amountType = 'monthly';
  const amountTypeField = document.createElement('div');
  amountTypeField.className = 'modal-field';
  const amountTypeLabel = document.createElement('div');
  amountTypeLabel.className = 'modal-field-label';
  amountTypeLabel.textContent = 'Amount Type';
  const amountTypeRow = document.createElement('div');
  amountTypeRow.className = 'modal-type-pills';
  amountTypeField.appendChild(amountTypeLabel);
  amountTypeField.appendChild(amountTypeRow);
  descAmountGroup.appendChild(amountTypeField);

  const perMonthPill = document.createElement('button');
  perMonthPill.type = 'button';
  perMonthPill.className = 'pill';
  perMonthPill.textContent = 'Per Month';
  const perDiemPill = document.createElement('button');
  perDiemPill.type = 'button';
  perDiemPill.className = 'pill';
  perDiemPill.textContent = 'Per Diem';
  amountTypeRow.appendChild(perMonthPill);
  amountTypeRow.appendChild(perDiemPill);
  const syncAmountTypePills = () => {
    perMonthPill.classList.toggle('active', amountType === 'monthly');
    perDiemPill.classList.toggle('active', amountType === 'perDiem');
  };
  syncAmountTypePills();
  perMonthPill.addEventListener('click', ()=>{ amountType = 'monthly'; syncAmountTypePills(); });
  perDiemPill.addEventListener('click', ()=>{ amountType = 'perDiem'; syncAmountTypePills(); });

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
    const target = { kind: currentKind, category: categoryName, subcategory: subcategoryName };
    let anyAdded = false;
    selectedFreqs.forEach(freq=>{
      if (opts.onAdd(target, freq, labelInput.value, amountInput.value, amountType)) anyAdded = true;
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

// Budget editor's "+ Add income"/"+ Add expense" (right panel, a
// subcategory selected in the table): same modal, but writes into
// budgetDraft via addDraftBudgetItem instead, since nothing here is real
// until Save.
function openAddDraftItemModal(){
  if (!budgetSelection) return;
  const { kind, catId, subId } = budgetSelection;
  const list = kind === 'income' ? budgetDraft.income : budgetDraft.expenses;
  const cat = list.find(c=>c.id===catId);
  const sub = cat && cat.subcategories.find(s=>s.id===subId);
  if (!cat || !sub) return;
  openAddBudgetItemModal({
    kind,
    category: cat.name,
    subcategory: sub.name,
    getCategories: draftCategoriesFor,
    onAdd: addDraftBudgetItem,
  });
}

function renderRightProjectedList(container){
  const cmi = DATA.currentMonthIndex;
  const currentDay = DATA.currentDay;
  const items = getSelectedBudgetItems();
  const flatItems = items.filter(it=>!isPerDiemItem(it));
  const perDiemItems = items.filter(it=>isPerDiemItem(it));
  const txnRow = (t) => ({ dateLabel: (parseInt(t.date.slice(5,7),10))+'/'+(parseInt(t.date.slice(8,10),10)), description: t.description, amount: t.amount, planned: false });
  const rows = [];
  for (let m=0;m<12;m++){
    if (cmi !== null && m === cmi){
      // Current (partial) month — mirrors resolveBudgets' current-month
      // split exactly, at this one subcategory's own item granularity:
      //   - linked items: their own matched transactions, plus a
      //     "(remaining)" row for whatever's left of their plan (the
      //     spending-cap comparison — see itemMatchedActual).
      //   - unlinked items + whatever actual isn't claimed by a linked
      //     item: the old whichever's-bigger choice between showing as
      //     actual or as planned rows, just scoped to that leftover pool.
      //   - per diem items: unchanged, always a "(remaining)" row for
      //     their own remaining days, regardless of actual.
      const monthTxns = getSelectedTxns(m);
      const linkedItems = flatItems.filter(it=>it.linkedDescriptions && it.linkedDescriptions.length);
      const unlinkedItems = flatItems.filter(it=>!(it.linkedDescriptions && it.linkedDescriptions.length));
      const claimedDescriptions = new Set();
      linkedItems.forEach(it=>it.linkedDescriptions.forEach(d=>claimedDescriptions.add(d)));

      linkedItems.forEach(it=>{
        const matchedTxns = monthTxns.filter(t=>it.linkedDescriptions.includes(t.description));
        matchedTxns.forEach(t=>rows.push(txnRow(t)));
        const matched = matchedTxns.reduce((a,t)=>a+t.amount,0);
        const planned = it.monthly[m] || 0;
        if (Math.abs(planned) > Math.abs(matched)){
          const remaining = Math.round((planned-matched)*100)/100;
          if (remaining) rows.push({ dateLabel: MONTHS[m], description: `${it.label} (remaining)`, amount: remaining, planned: true });
        }
      });

      const residualTxns = monthTxns.filter(t=>!claimedDescriptions.has(t.description));
      const residualActual = residualTxns.reduce((a,t)=>a+t.amount,0);
      const unlinkedPlan = unlinkedItems.reduce((a,it)=>a+(it.monthly[m]||0),0);
      if (Math.abs(residualActual) > Math.abs(unlinkedPlan)){
        residualTxns.forEach(t=>rows.push(txnRow(t)));
      } else {
        unlinkedItems.forEach(it=>{
          const v = it.monthly[m];
          if (v) rows.push({ dateLabel: MONTHS[m], description: it.label, amount: v, planned: true });
        });
      }

      perDiemItems.forEach(it=>{
        const remainingDays = remainingDaysInMonth(DATA.year, m, currentDay);
        if (remainingDays <= 0) return;
        const rate = Number(it.amount) || 0;
        const v = Math.round(rate * remainingDays * 100)/100;
        if (v) rows.push({ dateLabel: MONTHS[m], description: `${it.label} (remaining)`, amount: v, planned: true });
      });
      continue;
    }
    if (cmi !== null && m < cmi){
      getSelectedTxns(m).forEach(t=>rows.push(txnRow(t)));
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
   DATA LOADING (CSV + budgets JSON)
   ============================================================ */
function setIOStatus(msg, kind){
  const el = document.getElementById('ioStatus');
  el.textContent = msg;
  el.className = 'io-status' + (kind?' '+kind:'');
}

function recomputeDerived(){
  BUDGETS = resolveBudgets(BUDGETS_RAW, DATA.year, DATA.currentMonthIndex, DATA.currentDay, DATA.transactions);
  ROLL = buildBudgetRollups(BUDGETS, DATA.categories, DATA.incomeSubcats);
}

function loadFromCSVs(files){
  try{
    const allRows = [];
    files.forEach(f => allRows.push(...parseFidelityCSV(f.text, f.name)));
    if (allRows.length === 0) throw new Error('No transaction rows found in the file(s) provided.');
    DATA = aggregate(allRows, files.map(f=>f.name));
    recomputeDerived();
    // The status bar's Transactions chip (driven by DATA.sourceFiles) shows
    // which file(s) are loaded, so no separate "Loaded N transactions..."
    // message is needed on success — only failures get one.
    setIOStatus('');
    renderAll();
  } catch(err){
    setIOStatus('Could not parse CSV: ' + err.message, 'err');
  }
}
async function onCSVPickerChange(e){
  const fileList = Array.from(e.target.files || []);
  if (!fileList.length) return;
  const files = await Promise.all(fileList.map(f => f.text().then(text=>({name:f.name, text}))));
  loadFromCSVs(files);
}

async function onBudgetPickerChange(e){
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try{
    const text = await file.text();
    const obj = JSON.parse(text);
    BUDGETS_RAW = { Expenses: obj.Expenses || {}, Income: obj.Income || {} };
    budgetFileName = file.name;
    budgetDirty = false;
    recomputeDerived();
    // Same reasoning as loadFromCSVs above — the status bar's Budget chip
    // shows the loaded filename itself, so only failures need a message.
    setIOStatus('');
    renderAll();
  } catch(err){
    setIOStatus('Could not read budgets file: ' + err.message, 'err');
  }
}

// Every export gets a freshly timestamped filename, regardless of whether
// this budget was loaded from a file, previously exported, or created from
// scratch — e.g. "Budget-2026-09071423.json".
function timestampedBudgetFileName(){
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  const mmdd = `${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const hhmm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `Budget-${d.getFullYear()}-${mmdd}${hhmm}.json`;
}

function downloadBudgetsJSON(){
  const filename = timestampedBudgetFileName();
  const blob = new Blob([JSON.stringify(BUDGETS_RAW, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  budgetFileName = filename;
  budgetDirty = false;
  renderStatusBar();
}

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
      budgetFileName = 'budgets.json';
      budgetDirty = false;
      recomputeDerived();
      renderAll();
    }
  } catch(e){ /* expected under file:// */ }
}

/* ============================================================
   STATUS BAR (bottom panel) — the persistent Transactions/Budget file
   chip. Rebuilt from scratch on every render rather than patched in
   place: it's cheap (a handful of nodes) and, since it owns the actual
   csvPicker/budgetPicker <input>s, rebuilding is what lets the
   Open.../Change... labels, filenames and Export button all stay in sync
   with DATA.sourceFiles/budgetFileName/budgetDirty without separate
   bookkeeping.
   ============================================================ */
function buildFilePickerLabel(labelText, { id, accept, multiple, cssClass, onChange }){
  const label = document.createElement('label');
  label.className = cssClass;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'file';
  input.id = id;
  input.accept = accept;
  if (multiple) input.multiple = true;
  // Disabled for the duration of budget-edit mode, same as every other
  // data-loading control (Import CSV, etc.) — editing a draft while the
  // underlying data shifts under it would be surprising.
  input.disabled = budgetEditMode;
  input.addEventListener('change', onChange);
  label.appendChild(input);
  return label;
}

function renderStatusBar(){
  const chip = document.getElementById('statusChip');
  chip.innerHTML = '';

  const txnSeg = document.createElement('div');
  txnSeg.className = 'status-segment';
  const txnLabel = document.createElement('span');
  txnLabel.className = 'status-label';
  txnLabel.textContent = 'Transactions:';
  txnSeg.appendChild(txnLabel);
  if (!DATA.sourceFiles.length){
    txnSeg.appendChild(buildFilePickerLabel('Open...', {
      id:'csvPicker', accept:'.csv', multiple:true,
      cssClass:'status-open-link', onChange:onCSVPickerChange,
    }));
  } else {
    const name = document.createElement('span');
    name.className = 'status-filename';
    name.textContent = DATA.sourceFiles.join(', ');
    txnSeg.appendChild(name);
    txnSeg.appendChild(buildFilePickerLabel('Change...', {
      id:'csvPicker', accept:'.csv', multiple:true,
      cssClass:'status-change-link', onChange:onCSVPickerChange,
    }));
  }
  chip.appendChild(txnSeg);

  const divider = document.createElement('div');
  divider.className = 'status-divider';
  chip.appendChild(divider);

  const budgetSeg = document.createElement('div');
  budgetSeg.className = 'status-segment';
  const budgetLabel = document.createElement('span');
  budgetLabel.className = 'status-label';
  budgetLabel.textContent = 'Budget:';
  budgetSeg.appendChild(budgetLabel);
  // A budget "counts" as loaded for display purposes once it either came
  // from a file or has unexported edits (a from-scratch draft that's been
  // saved at least once) — either way there's now something to Export or
  // Change away from, so it's no longer the empty "Open..." state.
  if (!budgetFileName && !budgetDirty){
    budgetSeg.appendChild(buildFilePickerLabel('Open...', {
      id:'budgetPicker', accept:'.json',
      cssClass:'status-open-link', onChange:onBudgetPickerChange,
    }));
  } else {
    const name = document.createElement('span');
    name.className = 'status-filename';
    name.textContent = budgetFileName || 'New budget';
    budgetSeg.appendChild(name);
    if (budgetDirty){
      const edited = document.createElement('span');
      edited.className = 'status-edited';
      edited.textContent = '(edited)';
      budgetSeg.appendChild(edited);
      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'status-export';
      exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', downloadBudgetsJSON);
      budgetSeg.appendChild(exportBtn);
    }
    budgetSeg.appendChild(buildFilePickerLabel('Change...', {
      id:'budgetPicker', accept:'.json',
      cssClass:'status-change-link', onChange:onBudgetPickerChange,
    }));
  }
  chip.appendChild(budgetSeg);
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */
function renderAll(){
  renderLeftNav();
  renderStatusBar();
  // renderAll() is always a real page change (new timeframe/tab/mode, a
  // fresh CSV/budget load, ...) so — unlike an in-place update such as
  // selecting or expanding a row — it should start scrolled to the top
  // rather than preserving wherever the previous view happened to be.
  renderMid({ resetScroll: true });
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
