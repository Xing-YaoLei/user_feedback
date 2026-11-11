// 采集编排器：按目标区域分块探索，只通过 MapController 的可见交互工作。
//
// 两阶段策略：
//  阶段一（粗级聚合展开）：在 startZoom 网格上逐块进入，反复点击可见聚合直到最大级别，
//    能展开的全部展开并采集；最大级别仍为红色的重合聚合登记为“未完成”。
//  阶段二（最大级细网格覆盖）：以 maxZoom 视口的 90% 为步长建立重叠细网格，
//    蛇形逐屏移动，保证边缘/漏点全部进入视口，已知编号只做去重不重复点开。
//
// 规则：
//  - 边缘标记天然重复出现，按稳定编号去重（记录 firstSeenCell）；
//  - 无法进一步展开的聚合标为未完成，绝不估算成已采集；
//  - 每次移动后等 HUD 回到“空闲”再操作，处理移动加载延迟；
//  - 分块边界检查暂停信号并原子落盘，支持随时恢复。
import type { Browser } from '@playwright/test';
import { MapController } from './map-controller.ts';
import { makeGrid, haversineMeters } from './geo.ts';
import {
  createInitialState,
  loadState,
  saveState,
  isPauseRequested,
} from './state.ts';
import { buildReport } from './report.ts';
import type {
  CrawlState,
  CellState,
  StationRecord,
  UnresolvedCluster,
  LatLng,
  BBox,
} from './types.ts';

export interface CrawlOptions {
  url: string;
  stateFile: string;
  pauseFile: string;
  reportFile: string;
  bbox: BBox;
  maxZoom: number;
  width: number;
  height: number;
  startZoom: number;
  maxCells?: number; // 测试用：细网格只跑前 N 个分块
}

const MAX_CLUSTER_CLICKS = 80;
const FINE_GRID_FRACTION = 0.9; // 细网格步长 = 90% 视口跨度 → 10% 重叠带，必须大于 panTo 容差带

export class Crawler {
  private browser: Browser;
  private opts: CrawlOptions;
  private state: CrawlState;
  private map!: MapController;

  constructor(browser: Browser, opts: CrawlOptions, state: CrawlState) {
    this.browser = browser;
    this.opts = opts;
    this.state = state;
  }

  static async create(browser: Browser, opts: CrawlOptions): Promise<Crawler> {
    let state = await loadState(opts.stateFile);
    const map = await MapController.launch(browser, opts.url, opts.width, opts.height);
    try {
      if (state) {
        if (state.viewport.width !== opts.width || state.viewport.height !== opts.height) {
          state = await Crawler.rebuildGrid(state, map, opts);
        }
      } else {
        // 细网格按最大缩放级别的视口跨度建立
        await map.setZoom(opts.maxZoom);
        const fineSpan = await map.estimateViewportSpan();
        const fine = makeGrid(opts.bbox, fineSpan, FINE_GRID_FRACTION, true);
        // 粗网格按起始缩放级别建立（少量分块，只负责触发聚合展开）
        await map.setZoom(opts.startZoom);
        const coarseSpan = await map.estimateViewportSpan();
        const coarse = makeGrid(opts.bbox, coarseSpan, 0.8);
        state = createInitialState(
          `run-${Date.now()}`,
          opts.bbox,
          opts.maxZoom,
          { width: opts.width, height: opts.height },
          { rows: fine.rows, cols: fine.cols, stepLat: fine.stepLat, stepLng: fine.stepLng },
          fine.cells.map((c) => ({
            id: c.id,
            row: c.row,
            col: c.col,
            center: c.center,
            status: 'pending' as const,
            visits: 0,
            stationIds: [],
            unresolvedKeys: [],
          }))
        );
        (state as CrawlState & { coarseCells?: CellState[] }).coarseCells = coarse.cells.map((c) => ({
          id: `coarse-${c.id}`,
          row: c.row,
          col: c.col,
          center: c.center,
          status: 'pending' as const,
          visits: 0,
          stationIds: [],
          unresolvedKeys: [],
        }));
      }
      await saveState(opts.stateFile, state);
    } finally {
      await map.close();
    }
    return new Crawler(browser, opts, state);
  }

  private static async rebuildGrid(
    prev: CrawlState,
    map: MapController,
    opts: CrawlOptions
  ): Promise<CrawlState> {
    await map.setZoom(opts.maxZoom);
    const span = await map.estimateViewportSpan();
    const grid = makeGrid(opts.bbox, span, FINE_GRID_FRACTION, true);
    const cells: CellState[] = grid.cells.map((c) => ({
      id: c.id,
      row: c.row,
      col: c.col,
      center: c.center,
      status: 'pending', // 视口变化后旧覆盖不可信，全部重访；已采集资料保留
      visits: 0,
      stationIds: [],
      unresolvedKeys: [],
    }));
    return {
      ...prev,
      viewport: { width: opts.width, height: opts.height },
      grid: { rows: grid.rows, cols: grid.cols, stepLat: grid.stepLat, stepLng: grid.stepLng },
      cells,
      cursor: 0,
      paused: false,
      updatedAt: new Date().toISOString(),
    };
  }

  get currentState(): CrawlState {
    return this.state;
  }

  /** 目标区域判断（含边缘容差，度）。 */
  private withinBBox(lat: number, lng: number, margin: number): boolean {
    const b = this.opts.bbox;
    return (
      lat >= b.minLat - margin && lat <= b.maxLat + margin &&
      lng >= b.minLng - margin && lng <= b.maxLng + margin
    );
  }

  private track(cell: string, zoom: number, center: LatLng, action: string): void {
    this.state.path.push({ cell, zoom, lat: center.lat, lng: center.lng, action, at: new Date().toISOString() });
  }

  async run(): Promise<CrawlState> {
    this.state.paused = false; // 恢复运行时清除上次的暂停标志
    this.map = await MapController.launch(this.browser, this.opts.url, this.opts.width, this.opts.height);
    try {
      // 阶段一：粗级聚合展开（全新运行才需要；恢复时若已完成则跳过）
      const ext = this.state as CrawlState & { coarseDone?: boolean; coarseCells?: CellState[] };
      if (!ext.coarseDone && ext.coarseCells) {
        await this.coarsePhase(ext.coarseCells);
        ext.coarseDone = true;
        await saveState(this.opts.stateFile, this.state);
      }

      // 阶段二：最大级细网格蛇形覆盖
      const limit = this.opts.maxCells ?? this.state.cells.length;
      for (let i = this.state.cursor; i < limit; i++) {
        if (await isPauseRequested(this.opts.pauseFile)) {
          this.state.paused = true;
          this.state.cursor = i; // 当前分块尚未开始，恢复时重做
          await saveState(this.opts.stateFile, this.state);
          return this.state;
        }
        const cell = this.state.cells[i];
        if (cell.status === 'done') {
          this.state.cursor = i + 1;
          continue;
        }
        await this.processFineCell(cell);
        cell.status = 'done';
        cell.visits += 1;
        this.state.cursor = i + 1;
        await saveState(this.opts.stateFile, this.state);
      }

      // 阶段三：收尾补扫。标记可能在缩放/重排动画中间态被访问而未打开详情，
      // 全部网格走完后回到每个分块，待标记完全稳定再补采剩余可见标记。
      if (this.opts.maxCells === undefined || this.state.cursor >= this.state.cells.length) {
        await this.recoverySweep();
      }

      this.state.finished = this.state.cursor >= this.state.cells.length;
      await saveState(this.opts.stateFile, this.state);
      await buildReport(this.state, this.opts.reportFile, this.opts.stateFile);
      return this.state;
    } finally {
      await this.map.close();
    }
  }

  /** 阶段一：粗网格逐块进入，点击聚合直到最大级别，采集顺带可见的单个标记。 */
  private async coarsePhase(cells: CellState[]): Promise<void> {
    await this.map.setZoom(this.opts.startZoom);
    for (const cell of cells) {
      await this.map.panTo(cell.center);
      const hud0 = await this.map.getHud();
      this.track(cell.id, hud0.zoom, cell.center, 'enter-coarse-cell');
      await this.collectVisibleStations(cell);

      let clicks = 0;
      let staleRounds = 0;
      let lastSignature = '';
      while (clicks < MAX_CLUSTER_CLICKS) {
        const hud = await this.map.getHud();
        const clusters = await this.map.listClusters();
        await this.registerStuckClusters(clusters, cell, hud.zoom);
        const expandable = clusters.filter((c) => !c.stuck);
        if (expandable.length === 0) break;

        const signature = `${hud.zoom}|${clusters.map((c) => `${c.x},${c.y},${c.count}`).join(';')}`;
        if (signature === lastSignature) {
          staleRounds += 1;
          if (staleRounds >= 2) break; // 点击后画面无变化，防止死循环
        } else {
          staleRounds = 0;
          lastSignature = signature;
        }

        const before = await this.map.getHud();
        const result = await this.map.clickCluster(expandable[0]);
        clicks += 1;
        const after = await this.map.getHud();
        this.track(cell.id, after.zoom, { lat: after.lat, lng: after.lng }, 'click-cluster');
        if (result.kind === 'stuck') {
          // 地图明确弹出“无法展开”提示，登记未完成
          await this.registerStuck(expandable[0], result.count, cell, after.zoom);
        }
        // 注意：普通聚合在最大级别点击无变化时不登记——细网格阶段会以红色 stuck 类为准重新判定
        await this.collectVisibleStations(cell);
      }
      await this.map.closePopups();
    }
  }

  /** 阶段二：最大级细网格单屏采集。 */
  private async processFineCell(cell: CellState): Promise<void> {
    await this.map.setZoom(this.opts.maxZoom);
    await this.map.panTo(cell.center);
    const hud = await this.map.getHud();
    this.track(cell.id, hud.zoom, cell.center, 'enter-cell');

    // 等标记集合稳定（应对移动后的加载延迟与聚合动画）
    let prev = await this.map.listStationMarkers();
    for (let round = 0; round < 3; round++) {
      await this.map.page.waitForTimeout(150);
      const cur = await this.map.listStationMarkers();
      if (sameMarkerSet(prev, cur)) break;
      prev = cur;
    }

    // 两轮采集：第一轮后可能有标记被弹窗遮挡而未打开，清弹窗补采一轮
    await this.collectVisibleStations(cell);
    const stillVisible = (await this.map.listStationMarkers()).filter(
      (m) => !this.state.stations[m.id]
    );
    if (stillVisible.length > 0) {
      await this.map.closePopups();
      await this.collectVisibleStations(cell);
    }

    const clusters = await this.map.listClusters();
    const hud2 = await this.map.getHud();
    await this.registerStuckClusters(clusters, cell, hud2.zoom);
    await this.map.closePopups();
  }

  /**
   * 阶段三收尾补扫：重访每个分块，给标记足够时间从动画中间态恢复到稳定可点击状态，
   * 补采仍未收集的可见标记。只对“当前仍有未采集标记”的分块真正操作，其余快速跳过。
   */
  private async recoverySweep(): Promise<void> {
    await this.map.setZoom(this.opts.maxZoom);
    for (const cell of this.state.cells) {
      await this.map.panTo(cell.center);
      // 移动后充分等待：加载延迟 + 标记重排动画完全结束
      await this.map.page.waitForTimeout(400);
      let markers = await this.map.listStationMarkers();
      // 连续两轮集合一致才认为稳定
      for (let round = 0; round < 3; round++) {
        await this.map.page.waitForTimeout(200);
        const cur = await this.map.listStationMarkers();
        if (sameMarkerSet(markers, cur)) break;
        markers = cur;
      }
      const pending = markers.filter((m) => !this.state.stations[m.id]);
      if (pending.length === 0) continue;
      this.track(cell.id, this.opts.maxZoom, cell.center, 'recovery-sweep');
      await this.map.closePopups();
      await this.collectVisibleStations(cell);
      await this.map.closePopups();
      await saveState(this.opts.stateFile, this.state);
    }
  }

  /** 枚举当前视口内所有单个测站标记，逐个点开详情；已知编号只登记去重。 */
  private async collectVisibleStations(cell: CellState): Promise<void> {
    const markers = await this.map.listStationMarkers();
    for (const marker of markers) {
      if (this.state.stations[marker.id]) {
        if (!cell.stationIds.includes(marker.id)) cell.stationIds.push(marker.id);
        continue; // 边缘重复：不再重复点开详情
      }
      const detail = await this.map.openStationDetail(marker);
      if (!detail) continue; // 被遮挡/未弹出：后续重叠屏还会遇到
      const id = detail['稳定编号'] || marker.id;
      if (this.state.stations[id]) {
        if (!cell.stationIds.includes(id)) cell.stationIds.push(id);
        await this.map.closePopups();
        continue;
      }
      const record: StationRecord = {
        id,
        name: '',
        type: detail['类型'] ?? '',
        status: detail['状态'] ?? '',
        lat: Number(detail['纬度']),
        lng: Number(detail['经度']),
        elevation: Number(detail['海拔(米)']),
        installDate: detail['安装日期'] ?? '',
        firstSeenCell: cell.id,
        collectedAt: new Date().toISOString(),
      };
      // 粗阶段视野可能覆盖目标区域之外：只登记目标 bbox（含边缘容差）内的测站
      if (!this.withinBBox(record.lat, record.lng, 0)) {
        await this.map.closePopups();
        continue;
      }
      const name = await this.map.page
        .locator('[data-testid="station-detail"] h3')
        .innerText()
        .catch(() => '');
      if (name) record.name = name.trim();
      this.state.stations[id] = record;
      if (!cell.stationIds.includes(id)) cell.stationIds.push(id);
      const hud = await this.map.getHud();
      this.track(cell.id, hud.zoom, { lat: record.lat, lng: record.lng }, `collect:${id}`);
      await this.map.closePopups();
    }
  }

  private async registerStuckClusters(
    clusters: Awaited<ReturnType<MapController['listClusters']>>,
    cell: CellState,
    zoom: number
  ): Promise<void> {
    for (const c of clusters) {
      if (!c.stuck) continue;
      if (zoom < this.opts.maxZoom) continue; // 红色聚合只在最大级别才可信
      await this.registerStuck(c, c.count, cell, zoom);
    }
  }

  private async registerStuck(
    cluster: { x: number; y: number; count: number },
    count: number,
    cell: CellState,
    zoom: number
  ): Promise<void> {
    const hud = await this.map.getHud();
    // 用 HUD 中心 + 像素偏移反算聚合地理位置（纯客户端数学，不读图层）
    const box = await this.map.page.locator('#map').boundingBox();
    let lat = hud.lat;
    let lng = hud.lng;
    if (box) {
      const offsetX = cluster.x - box.width / 2;
      const offsetY = cluster.y - box.height / 2;
      const worldW = 256 * 2 ** zoom;
      lng = hud.lng + (offsetX / worldW) * 360;
      const metersPerPixel = (156543.03 * Math.cos((hud.lat * Math.PI) / 180)) / 2 ** zoom;
      lat = hud.lat - (offsetY * metersPerPixel) / 111320;
    }
    // 同一物理聚合：坐标完全相同（误差 < 5 米）才合并；不同位置必须分别登记
    const existing = Object.values(this.state.unresolved).find(
      (u) => haversineMeters(u, { lat, lng }) < 5
    );
    // 目标区域之外的聚合不登记
    if (!existing && !this.withinBBox(lat, lng, 0)) return;
    const key =
      existing?.key ??
      `UNR-${String(Object.keys(this.state.unresolved).length + 1).padStart(3, '0')}`;
    const record: UnresolvedCluster = {
      key,
      lat,
      lng,
      // 重合组内测站坐标完全一致，不同屏看到的可见数应当相同；以当前读数为准，不做累加
      visibleCount: count,
      cell: cell.id,
      reason: '最大缩放级别下坐标完全重合，聚合无法进一步展开',
      detectedAt: existing?.detectedAt ?? new Date().toISOString(),
    };
    this.state.unresolved[key] = record;
    if (!cell.unresolvedKeys.includes(key)) cell.unresolvedKeys.push(key);
  }
}

function sameMarkerSet(
  a: { id: string }[],
  b: { id: string }[]
): boolean {
  if (a.length !== b.length) return false;
  const ka = new Set(a.map((m) => m.id));
  return b.every((m) => ka.has(m.id));
}
