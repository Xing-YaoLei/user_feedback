// 自包含 HTML 回看报告：覆盖网格、扫描路径、已采集测站、未完成聚合。
// 纯 SVG，无外部依赖，浏览器直接打开即可。
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CrawlState } from './types.ts';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

export async function buildReport(state: CrawlState, reportFile: string, stateFile: string): Promise<void> {
  const { bbox } = state;
  const W = 900;
  const H = 760;
  const PAD = 40;
  const x = (lng: number) =>
    PAD + ((lng - bbox.minLng) / (bbox.maxLng - bbox.minLng)) * (W - 2 * PAD);
  const y = (lat: number) =>
    H - PAD - ((lat - bbox.minLat) / (bbox.maxLat - bbox.minLat)) * (H - 2 * PAD);

  const doneCells = state.cells.filter((c) => c.status === 'done');
  const cellW = (W - 2 * PAD) / state.grid.cols;
  const cellH = (H - 2 * PAD) / state.grid.rows;

  const gridSvg = state.cells
    .map((c) => {
      // overscan 分块中心可能在 bbox 外，矩形坐标钳制到画布框内
      const cx = Math.min(Math.max(x(c.center.lng), PAD), W - PAD);
      const cy = Math.min(Math.max(y(c.center.lat), PAD), H - PAD);
      const fill = c.status === 'done' ? 'rgba(16,185,129,0.18)' : 'rgba(148,163,184,0.10)';
      const stroke = c.status === 'done' ? '#059669' : '#94a3b8';
      const gx0 = cx - cellW / 2;
      const gy0 = cy - cellH / 2;
      const gx = Math.max(gx0, PAD);
      const gy = Math.max(gy0, PAD);
      const gw = Math.min(cellW, W - PAD - gx);
      const gh = Math.min(cellH, H - PAD - gy);
      return `<g>
        <rect x="${gx.toFixed(1)}" y="${gy.toFixed(1)}" width="${gw.toFixed(1)}" height="${gh.toFixed(1)}"
              fill="${fill}" stroke="${stroke}" stroke-width="1" data-testid="grid-cell" data-cell="${esc(c.id)}" data-status="${c.status}"/>
        <text x="${cx.toFixed(1)}" y="${(gy + 12).toFixed(1)}" font-size="9" fill="#475569" text-anchor="middle">${esc(c.id)}</text>
      </g>`;
    })
    .join('\n');

  // 扫描路径（按 path 顺序连线，不同 action 用颜色区分）
  const pathGroups = new Map<string, string[]>();
  for (const p of state.path) {
    const pts = pathGroups.get(p.action.split(':')[0]) ?? [];
    pts.push(`${x(p.lng).toFixed(1)},${y(p.lat).toFixed(1)}`);
    pathGroups.set(p.action.split(':')[0], pts);
  }
  const pathColors: Record<string, string> = {
    'enter-coarse-cell': '#7c3aed',
    'enter-cell': '#0284c7',
    'click-cluster': '#ea580c',
    collect: '#16a34a',
    'recovery-sweep': '#db2777',
  };
  const pathSvg = [...pathGroups.entries()]
    .map(([action, pts]) => {
      if (pts.length < 2) return '';
      return `<polyline points="${pts.join(' ')}" fill="none"
        stroke="${pathColors[action] ?? '#64748b'}" stroke-width="1.4" opacity="0.75"
        stroke-dasharray="${action === 'click-cluster' ? '5 3' : 'none'}" data-testid="scan-path" data-action="${esc(action)}"/>`;
    })
    .join('\n');

  const stationSvg = Object.values(state.stations)
    .map(
      (s) => `<circle cx="${x(s.lng).toFixed(1)}" cy="${y(s.lat).toFixed(1)}" r="3.2"
        fill="#2563eb" stroke="#fff" stroke-width="0.8" data-testid="report-station" data-id="${esc(s.id)}">
        <title>${esc(s.id)} ${esc(s.name)}（${esc(s.status)}）</title></circle>`
    )
    .join('\n');

  const unresolvedSvg = Object.values(state.unresolved)
    .map(
      (u) => `<g data-testid="report-unresolved" data-key="${esc(u.key)}">
        <circle cx="${x(u.lng).toFixed(1)}" cy="${y(u.lat).toFixed(1)}" r="9"
          fill="rgba(185,28,28,0.18)" stroke="#b91c1c" stroke-width="2"/>
        <text x="${x(u.lng).toFixed(1)}" y="${(y(u.lat) + 3.5).toFixed(1)}" font-size="10"
          fill="#b91c1c" text-anchor="middle" font-weight="bold">${u.visibleCount}</text>
        <title>${esc(u.key)}：${esc(u.reason)}（可见 ${u.visibleCount} 个，分块 ${esc(u.cell)}）</title>
      </g>`
    )
    .join('\n');

  const totalStations = Object.keys(state.stations).length;
  const totalUnresolved = Object.keys(state.unresolved).length;
  const hiddenInUnresolved = Object.values(state.unresolved).reduce((n, u) => n + u.visibleCount, 0);
  const completion = state.finished ? '已完成' : state.paused ? '已暂停' : '未完成';

  const stationRows = Object.values(state.stations)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.type)}</td>
      <td>${esc(s.status)}</td><td>${s.lat.toFixed(6)}</td><td>${s.lng.toFixed(6)}</td>
      <td>${esc(s.firstSeenCell)}</td></tr>`
    )
    .join('');

  const unresolvedRows = Object.values(state.unresolved)
    .map(
      (u) => `<tr><td>${esc(u.key)}</td><td>${u.lat.toFixed(6)}</td><td>${u.lng.toFixed(6)}</td>
      <td>${u.visibleCount}</td><td>${esc(u.cell)}</td><td>${esc(u.reason)}</td></tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>采集回看报告 ${esc(state.runId)}</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 24px; color: #0f172a; background: #f8fafc; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 18px; min-width: 130px; }
  .card .num { font-size: 26px; font-weight: 700; }
  .card.warn .num { color: #b91c1c; } .card.ok .num { color: #15803d; }
  svg { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; background: #fff; }
  th, td { border: 1px solid #e2e8f0; padding: 5px 8px; text-align: left; }
  th { background: #f1f5f9; }
  .legend span { display: inline-block; margin-right: 14px; font-size: 12px; }
  .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
  code { background: #eef2ff; padding: 1px 5px; border-radius: 4px; }
</style></head><body>
<h1>测站采集回看报告</h1>
<p>运行编号 <code>${esc(state.runId)}</code> · 开始 ${esc(state.startedAt)} · 更新 ${esc(state.updatedAt)} · 状态 <strong>${completion}</strong></p>
<div class="cards">
  <div class="card ok"><div>已采集测站</div><div class="num" data-testid="stat-collected">${totalStations}</div></div>
  <div class="card"><div>已覆盖分块</div><div class="num">${doneCells.length}/${state.cells.length}</div></div>
  <div class="card warn"><div>未完成聚合</div><div class="num" data-testid="stat-unresolved">${totalUnresolved}</div></div>
  <div class="card warn"><div>聚合内未采集测站（不估算）</div><div class="num">${hiddenInUnresolved}</div></div>
  <div class="card"><div>路径点数</div><div class="num">${state.path.length}</div></div>
</div>
<div class="legend">
  <span><i class="swatch" style="background:#16a34a"></i>已覆盖网格</span>
  <span><i class="swatch" style="background:#94a3b8"></i>未覆盖网格</span>
  <span><i class="swatch" style="background:#2563eb"></i>已采集测站</span>
  <span><i class="swatch" style="background:#b91c1c"></i>未完成聚合</span>
  <span>紫线=粗网格定位 · 蓝线=细网格逐屏覆盖 · 橙虚线=聚合展开 · 绿点序列=详情采集 · 粉线=收尾补扫</span>
</div>
<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:980px" role="img" aria-label="覆盖网格与扫描路径">
  <rect x="${PAD}" y="${PAD}" width="${W - 2 * PAD}" height="${H - 2 * PAD}" fill="#f8fafc" stroke="#0ea5e9" stroke-dasharray="6 4"/>
  ${gridSvg}
  ${pathSvg}
  ${stationSvg}
  ${unresolvedSvg}
</svg>

<h2>已采集测站明细（${totalStations}）</h2>
<table data-testid="station-table"><thead><tr>
  <th>稳定编号</th><th>名称</th><th>类型</th><th>状态</th><th>纬度</th><th>经度</th><th>首次发现分块</th>
</tr></thead><tbody>${stationRows}</tbody></table>

<h2>未完成聚合（${totalUnresolved}）— 这些测站未计入采集结果</h2>
<table data-testid="unresolved-table"><thead><tr>
  <th>编号</th><th>纬度</th><th>经度</th><th>可见标记数</th><th>所在分块</th><th>原因</th>
</tr></thead><tbody>${unresolvedRows}</tbody></table>

<p style="color:#64748b;font-size:12px;margin-top:24px">
  状态文件：<code>${esc(stateFile)}</code> · 本报告由采集器仅依据可见地图交互结果生成，未读取任何页面内部数据对象或隐藏接口。
</p>
</body></html>`;

  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, html);
}
