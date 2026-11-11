// Web Mercator 纯函数：机器人自己根据 HUD 上可见的经纬度/缩放做坐标换算，
// 不读取地图实例、不读取任何页面内部对象。
import type { BBox, LatLng } from './types.ts';

const R = 6378137; // 地球半径（米）

export function lngToWorldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom) * 256;
}
export function latToWorldY(lat: number, zoom: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, zoom) * 256;
}
export function worldYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (Math.pow(2, zoom) * 256);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** 计算把地图中心从 from 移到 to 需要在地图容器上拖动的像素向量（缩放不变期间）。 */
export function dragPixels(from: LatLng, to: LatLng, zoom: number): { dx: number; dy: number } {
  const dx = lngToWorldX(from.lng, zoom) - lngToWorldX(to.lng, zoom);
  const dy = latToWorldY(from.lat, zoom) - latToWorldY(to.lat, zoom);
  return { dx, dy };
}

/**
 * 视口跨度（度）→ 覆盖网格。
 * fraction 为步长占视口跨度的比例（<1 即相邻分块有重叠）。
 * overscan=true 时边界分块中心不向 bbox 内钳制，而是保持半格外移，
 * 使视口完整覆盖 bbox 外一圈；区域外数据由采集层按 bbox 过滤。
 */
export function makeGrid(
  bbox: BBox,
  viewportSpan: { lat: number; lng: number },
  fraction = 0.6,
  overscan = false
): {
  cells: { id: string; row: number; col: number; center: LatLng }[];
  rows: number;
  cols: number;
  stepLat: number;
  stepLng: number;
} {
  const stepLat = viewportSpan.lat * fraction;
  const stepLng = viewportSpan.lng * fraction;
  const rows = Math.max(1, Math.ceil((bbox.maxLat - bbox.minLat) / stepLat));
  const cols = Math.max(1, Math.ceil((bbox.maxLng - bbox.minLng) / stepLng));
  const cells: { id: string; row: number; col: number; center: LatLng }[] = [];
  // 蛇形路径（boustrophedon）：相邻分块短距离移动，减少空程
  for (let r = 0; r < rows; r++) {
    const rawLat = bbox.minLat + (r + 0.5) * stepLat;
    const rowCells: { id: string; row: number; col: number; center: LatLng }[] = [];
    for (let c = 0; c < cols; c++) {
      const rawLng = bbox.minLng + (c + 0.5) * stepLng;
      rowCells.push({
        id: `R${String(r).padStart(2, '0')}-C${String(c).padStart(2, '0')}`,
        row: r,
        col: c,
        center: overscan
          ? { lat: rawLat, lng: rawLng }
          : { lat: Math.min(rawLat, bbox.maxLat), lng: Math.min(rawLng, bbox.maxLng) },
      });
    }
    if (r % 2 === 1) rowCells.reverse();
    cells.push(...rowCells);
  }
  return { cells, rows, cols, stepLat, stepLng };
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
