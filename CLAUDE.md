# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Budgetr is a single-page budgeting app with **no build step, no package manager, and no backend**. It's plain HTML/CSS/JS:

- `index.html` — the whole DOM shell (three-panel layout + status bar)
- `js/app.js` — the entire application (~5,700 lines), vanilla JS, no framework
- `css/styles.css` — component styles (semantic variables)
- `css/tokens.css` — color primitives, generated from `design-tokens/color-tokens.json`
- `icons/` — SVG icons referenced via `<img>`
- `design-tokens/color-tokens.json` — a Figma variables export ("Dark" mode)

There is nothing to install and nothing to compile.

## Running it

Open `index.html` directly in a browser, or serve the directory statically, e.g.:

```bash
python3 -m http.server
```

There is no test suite, linter, or build/watch command in this repo.

## Data model and persistence

The app has no server and no `localStorage`/IndexedDB persistence — all state lives in memory and is lost on reload unless explicitly exported.

- **Transactions**: loaded by the user via a CSV file picker. `parseFidelityCSV` expects a **Fidelity Full View** export format specifically (header row 2, an `Amount` column, optional `DATA GLOSSARY` footer, optional "Hidden Transaction" column). `aggregate()` turns raw rows into `DATA`: income/expense monthly totals, a category→subcategory tree for expenses, a subcategory→description tree for income, and a flat `transactions` list. There's no multi-year support — `DATA.year` is just whichever year has the most rows.
- **Budgets**: a nested JSON structure (`BUDGETS_RAW`): `{ Expenses: { Category: { Subcategory: [item, ...] } }, Income: { Subcategory: [item, ...] } }`. Each line item has `freq` (`"monthly"`, a 3-letter month code, or scalar/12-array), `amountType` (`"monthly"` flat total or `"perDiem"` daily rate), and `linkedDescriptions` (ties the item to specific transaction descriptions for spend-cap-style forecasting). Budgets are loaded/saved as JSON files via file pickers — there's a budget editor mode (`budgetEditMode`) that edits a draft copy (`budgetDraft`) before committing back to `BUDGETS_RAW`.
- **Derived state**: `resolveBudgets()` combines `BUDGETS_RAW` with `DATA` (actuals) for the current year/month to produce `BUDGETS`; `buildBudgetRollups()` produces `ROLL`, the combined actual/budget/forecast numbers the UI renders from. Both are recomputed via `recomputeDerived()` any time `DATA` or `BUDGETS_RAW` changes.

## Rendering architecture

No virtual DOM, no components/props — direct DOM manipulation driven by global mutable state.

- `renderAll()` is the entry point: it re-renders the left nav, mid panel, right panel, and status bar in sequence, and is called after essentially every state-changing action (file load, tab switch, budget edit, etc.).
- `renderMid()` is the router for the center panel, branching on a few mutually exclusive modes held in globals: `budgetEditMode`, `timeframe === 'transactions'`, `timeframe === 'charts'`, `timeframe === 'year'`, or `timeframe` as a month index (0–11) for the month drill-down. Each branch calls its own `render*` function that rebuilds that section's DOM from scratch (`mid.innerHTML = ''` then append), while manually preserving/restoring scroll position across the rebuild.
- The right panel (`renderRight`) shows contextual detail for whatever's selected (`selectedSub`, budget selection, etc.) and auto-expands from its collapsed rail only when the selection actually changes.
- Key state globals (all declared together under the `STATE` comment block in `js/app.js`): `DATA`, `BUDGETS_RAW`/`BUDGETS`/`ROLL`, `timeframe`, `pill` (Year view YTD/Projection/Plan), `selectedSub`, search/sort/filter state for the Transactions tab (`searchQuery`, `txnSort`, `txnMonthFilter`, `txnDayFilter`, `txnChartView`), chart state (`chartRange`, `cashBalance`), and the budget editor's own draft state (`budgetEditMode`, `budgetDraft`, `budgetSelection`, etc.).

`js/app.js` is organized into clearly marked `/* ==== SECTION ==== */` comment blocks in this order: constants → CSV parsing → aggregation → budget schema/resolver → state → helpers → left nav → Year/Month table rendering → Transactions page + chart → Charts page (year net chart) → Budget editor → right panel → top-level load/save/clear actions → status bar → `renderAll()`.

## Design tokens

`css/tokens.css` is generated from `design-tokens/color-tokens.json` (a Figma export) — don't hand-edit its values; regenerate from the Figma source instead if the palette changes. `css/styles.css` maps these raw primitives (`--surface-*`, `--ink-*`) onto semantic variables (`--bg-*`, `--text-*`, `--accent-*`) so component CSS never references the primitives directly.

## Notable gotchas already solved in this codebase

- Icons are normally referenced via `<img src="icons/*.svg">`, but the delete icon is inlined as a literal SVG string in JS (`DELETE_ICON_SVG`) because `<img src>`/CSS `mask-image` references to local files can silently fail to render when the app is opened via `file://`.
