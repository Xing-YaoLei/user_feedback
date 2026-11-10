"""Self-contained HTML report: contract preview, schema evolution, conflict map.

The generated ``report.html`` needs no server or external assets — data is
embedded as JSON and rendered by a small vanilla-JS view. It provides:

* the active contract and per-path merge policy;
* the final schema tree with exact decimal / timestamp types;
* a per-batch schema-evolution timeline (integer promotions, decimal widening,
  new fields);
* a conflict table located by JSON path, batch id and policy decision;
* error-record provenance with raw source bytes.
"""

from __future__ import annotations

import json
from pathlib import Path

from .runner import ConversionResult


def build_report(result: ConversionResult, output_path: str | Path) -> str:
    payload = {
        "contract": result.contract.to_dict(),
        "output_parquet": result.output_parquet,
        "error_parquet": result.error_parquet,
        "record_written": result.record_written,
        "record_quarantined": result.record_quarantined,
        "parse_errors": result.parse_errors,
        "arrow_schema": result.arrow_schema,
        "final_schema": result.final_schema,
        "batch_snapshots": result.batch_snapshots,
        "merge_events": result.merge_events,
        "conflict_events": result.conflict_events,
    }
    output_path = Path(output_path)
    output_path.write_text(
        _HTML_TEMPLATE.replace("__DATA__", json.dumps(payload, ensure_ascii=False)),
        encoding="utf-8",
    )
    return str(output_path)


_HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>nested2arrow — contract &amp; conflict report</title>
<style>
  :root {
    --bg:#0f1420; --panel:#171e2e; --line:#27314a; --text:#e6eaf2;
    --muted:#93a0b8; --accent:#6ea8fe; --warn:#f5b454; --bad:#ff6b6b;
    --ok:#57d18d;
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",
         Roboto,"Helvetica Neue",Arial,sans-serif;
         background:var(--bg); color:var(--text); }
  header { padding:24px 32px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:20px; }
  h2 { font-size:15px; margin:28px 0 10px; color:var(--accent); }
  main { padding:8px 32px 48px; max-width:1180px; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line);
          border-radius:10px; padding:14px 16px; }
  .card .num { font-size:24px; font-weight:650; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase;
                 letter-spacing:.06em; }
  table { width:100%; border-collapse:collapse; background:var(--panel);
          border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line);
          vertical-align:top; font-size:13px; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  tr:last-child td { border-bottom:none; }
  code,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .path { color:var(--accent); }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px;
          font-size:11px; font-weight:650; }
  .pill.fail { background:rgba(255,107,107,.16); color:var(--bad); }
  .pill.quarantine { background:rgba(245,180,84,.16); color:var(--warn); }
  .pill.promote { background:rgba(87,209,141,.16); color:var(--ok); }
  pre { background:#0b101b; border:1px solid var(--line); border-radius:10px;
        padding:14px; overflow:auto; font-size:12.5px; }
  details { margin:6px 0; }
  summary { cursor:pointer; color:var(--muted); }
  .tree { font-family:ui-monospace,Menlo,monospace; font-size:12.5px;
          white-space:pre; }
  .muted { color:var(--muted); }
  .toolbar { display:flex; gap:8px; margin:10px 0; flex-wrap:wrap; }
  input,select { background:var(--panel); color:var(--text);
          border:1px solid var(--line); border-radius:8px; padding:7px 10px; }
  .empty { color:var(--muted); font-style:italic; padding:14px; }
</style>
</head>
<body>
<header>
  <h1>nested2arrow — contract preview &amp; conflict location</h1>
  <div class="muted" id="subtitle"></div>
</header>
<main>
  <section class="grid" id="stats"></section>

  <h2>1. Active contract</h2>
  <pre id="contract"></pre>

  <h2>2. Final schema (exact Arrow types)</h2>
  <div class="toolbar">
    <select id="batchSelect"></select>
  </div>
  <div class="tree" id="schemaTree"></div>
  <details><summary>Raw Arrow schema</summary><pre id="arrowSchema"></pre></details>

  <h2>3. Schema evolution across batches</h2>
  <table id="snapshots"><thead><tr>
    <th>Batch</th><th>Records</th><th>Schema summary</th>
  </tr></thead><tbody></tbody></table>

  <h2>4. Merge events (promotions / widenings)</h2>
  <div class="toolbar"><input id="mergeFilter" placeholder="filter by path…">
    </div>
  <table id="mergeTable"><thead><tr>
    <th>Batch</th><th>Path</th><th>Event</th><th>Before → After</th>
    <th>Detail</th><th>Policy</th>
  </tr></thead><tbody></tbody></table>

  <h2>5. Conflict locations</h2>
  <table id="conflictTable"><thead><tr>
    <th>Batch</th><th>Path</th><th>Before</th><th>After</th>
    <th>Detail</th><th>Policy</th>
  </tr></thead><tbody></tbody></table>

  <h2>6. Error outputs</h2>
  <div id="errorOutputs" class="muted"></div>
</main>
<script>
const DATA = __DATA__;
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pill = p => `<span class="pill ${esc(p)}">${esc(p)}</span>`;

document.getElementById("subtitle").textContent =
  "output: " + DATA.output_parquet;

const stats = [
  ["records written", DATA.record_written],
  ["quarantined", DATA.record_quarantined],
  ["parse errors", DATA.parse_errors],
  ["conflicts", DATA.conflict_events.length],
];
document.getElementById("stats").innerHTML = stats.map(([l,n]) =>
  `<div class="card"><div class="num">${n}</div>
   <div class="label">${esc(l)}</div></div>`).join("");

document.getElementById("contract").textContent =
  JSON.stringify(DATA.contract, null, 2);
document.getElementById("arrowSchema").textContent = DATA.arrow_schema;

// schema tree rendering
function renderTree(node, indent) {
  indent = indent || "";
  if (node && typeof node === "object" && !node.type) {
    return Object.entries(node).map(([k,v]) => {
      if (v && typeof v === "object" && (v.type === "array" ||
          !(v instanceof Array) && !v.type && Object.keys(v).length &&
          typeof Object.values(v)[0] === "object")) {
        return indent + esc(k) + ":\n" + renderTree(v, indent + "  ");
      }
      return indent + esc(k) + ": " + (v.type === "array"
        ? "array<" + renderTree(v.element, "").trim() + ">"
        : esc(v));
    }).join("\n");
  }
  if (node && node.type === "array") {
    return indent + "array<" + renderTree(node.element, "").trim() + ">";
  }
  return indent + esc(node);
}

const select = document.getElementById("batchSelect");
DATA.batch_snapshots.forEach(s => {
  const o = document.createElement("option");
  o.value = s.batch_id; o.textContent = "after batch " + s.batch_id;
  select.appendChild(o);
});
function paintSchema() {
  const snap = DATA.batch_snapshots[Number(select.value)] ||
    { schema: DATA.final_schema };
  document.getElementById("schemaTree").textContent =
    renderTree(snap.schema, "");
}
select.value = DATA.batch_snapshots.length - 1;
select.addEventListener("change", paintSchema);
paintSchema();

const snapBody = document.querySelector("#snapshots tbody");
snapBody.innerHTML = DATA.batch_snapshots.map(s =>
  `<tr><td>${s.batch_id}</td><td>${s.record_count}</td>
   <td class="mono">${esc(s.summary)}</td></tr>`).join("") ||
  '<tr><td colspan=3 class="empty">no batches</td></tr>';

function mergeRows(filter) {
  const body = document.querySelector("#mergeTable tbody");
  const rows = DATA.merge_events.filter(e =>
    !filter || e.path.includes(filter));
  body.innerHTML = rows.map(e =>
    `<tr><td>${e.batch_id}</td><td class="path mono">${esc(e.path)}</td>
     <td>${esc(e.action)}</td>
     <td class="mono">${esc(e.before)} → ${esc(e.after)}</td>
     <td>${esc(e.detail)}</td><td>${pill(e.policy)}</td></tr>`).join("") ||
    '<tr><td colspan=6 class="empty">no merge events</td></tr>';
}
mergeRows("");
document.getElementById("mergeFilter")
  .addEventListener("input", e => mergeRows(e.target.value));

const cBody = document.querySelector("#conflictTable tbody");
cBody.innerHTML = DATA.conflict_events.map(e =>
  `<tr><td>${e.batch_id}</td><td class="path mono">${esc(e.path)}</td>
   <td class="mono">${esc(e.before)}</td><td class="mono">${esc(e.after)}</td>
   <td>${esc(e.detail)}</td><td>${pill(e.policy)}</td></tr>`).join("") ||
  '<tr><td colspan=6 class="empty">no conflicts — schema is consistent</td></tr>';

document.getElementById("errorOutputs").textContent = DATA.error_parquet
  ? "error records: " + DATA.error_parquet + " (+ .jsonl sidecar)"
  : "no error records";
</script>
</body>
</html>
"""
