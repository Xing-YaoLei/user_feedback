// 浏览器交互层（架构红线：本文件只允许可见 DOM 操作）
// 允许：locator 定位、click/hover、mouse 拖拽、keyboard、boundingBox、可见文本读取。
// 禁止：page.evaluate / page.exposeFunction / window 读取 / fetch / XHR / 任何隐藏接口。
import type { Browser, Page, Locator } from '@playwright/test';
import { dragPixels, latToWorldY } from './geo.ts';
import type { LatLng } from './types.ts';

export interface VisibleMarker {
  id: string;
  x: number; // 相对地图容器的像素坐标
  y: number;
}

export interface VisibleCluster {
  count: number;
  x: number;
  y: number;
  stuck: boolean;
}

const LOADING_TEXT = '加载中';

export class MapController {
  readonly page: Page;
  private signChecked = false;
  // Leaflet：鼠标向屏幕右下拖 → 地图内容跟随右下 → 视野中心向西北（左上）移动，
  // 即视野位移 = -拖拽位移，初始符号取 -1，首次移动后再用 HUD 读数实测确认。
  private dragSignX = -1;
  private dragSignY = -1;

  private constructor(page: Page) {
    this.page = page;
  }

  static async launch(browser: Browser, url: string, width: number, height: number): Promise<MapController> {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const ctrl = new MapController(page);
    await ctrl.waitForMapReady();
    return ctrl;
  }

  async close(): Promise<void> {
    await this.page.context().close();
  }

  private get mapEl(): Locator {
    return this.page.locator('#map');
  }

  async waitForMapReady(): Promise<void> {
    // 等待 HUD 出现且首次数据加载完成（可见文本信号，不读内部状态）
    await this.page.locator('[data-testid="hud-zoom"]').waitFor({ state: 'visible', timeout: 15000 });
    await this.waitUntilIdle();
  }

  async waitUntilIdle(): Promise<void> {
    // 纯 locator 轮询 HUD 可见文本，绝不在页面上下文里执行任何函数
    const idle = this.page.locator('[data-testid="hud-loading"]', { hasText: '空闲' });
    await idle.waitFor({ state: 'visible', timeout: 20000 });
    await this.page.waitForTimeout(110); // 等聚合动画/标记重排稳定
  }

  async getHud(): Promise<{ zoom: number; lat: number; lng: number; loading: string; markers: number; clusters: number }> {
    const read = async (sel: string) =>
      (await this.page.locator(sel).innerText()).trim();
    const [zoom, lat, lng, loading, markers, clusters] = await Promise.all([
      read('[data-testid="hud-zoom"]'),
      read('[data-testid="hud-lat"]'),
      read('[data-testid="hud-lng"]'),
      read('[data-testid="hud-loading"]'),
      read('[data-testid="hud-markers"]'),
      read('[data-testid="hud-clusters"]'),
    ]);
    return {
      zoom: Number(zoom),
      lat: Number(lat),
      lng: Number(lng),
      loading,
      markers: Number(markers),
      clusters: Number(clusters),
    };
  }

  get isLoadingRule() {
    return LOADING_TEXT;
  }

  // ---------- 移动 / 缩放：全部是真人式输入 ----------

  /**
   * 拖拽地图使中心移动到 target（依据 HUD 读数迭代修正）。
   * 注意：标记/聚合图标是交互元素，从图标上按下不会触发地图拖拽，
   * 因此起点在多个候选位置中挑选，并对“零移动”做重试与符号自检。
   */
  async panTo(target: LatLng, toleranceDeg?: number): Promise<void> {
    const box = await this.mapEl.boundingBox();
    if (!box) throw new Error('地图容器不可见');
    // 容差随缩放自适应：约等于 8 个屏幕像素对应的地面角度
    const hud0 = await this.getHud();
    const worldW0 = 256 * 2 ** hud0.zoom;
    const tol = toleranceDeg ?? Math.max((8 / worldW0) * 360, 0.0003);
    // 避开 HUD（左上）、缩放控件（右上）、图例（左下）与中心标记的候选起点
    const anchors = [
      { fx: 0.5, fy: 0.72 },
      { fx: 0.32, fy: 0.55 },
      { fx: 0.68, fy: 0.55 },
      { fx: 0.5, fy: 0.4 },
    ];
    let anchorIdx = 0;
    for (let attempt = 0; attempt < 70; attempt++) {
      const hud = await this.getHud();
      const dLat = target.lat - hud.lat;
      const dLng = target.lng - hud.lng;
      if (Math.abs(dLat) <= tol && Math.abs(dLng) <= tol) return;

      const { dx, dy } = dragPixels({ lat: hud.lat, lng: hud.lng }, target, hud.zoom);
      // Leaflet：视野位移 = -拖拽位移；初始符号 -1，首次有效拖拽后用 HUD 实测确认
      let px = this.dragSignX * dx;
      let py = this.dragSignY * dy;
      // 接近目标时把拖拽量夹到最小有效位移（18px），避免反复越过目标
      const rawLen = Math.hypot(px, py);
      if (rawLen < 18 && rawLen > 0) {
        px = (px / rawLen) * 18;
        py = (py / rawLen) * 18;
      }
      const anchor = anchors[anchorIdx % anchors.length];
      const startX = box.x + box.width * anchor.fx;
      const startY = box.y + box.height * anchor.fy;
      // 单次拖拽限制在容器 40% 内：长距离自动分多段，避免一次拖出容器
      const len = Math.hypot(px, py);
      const cap = Math.min(box.width, box.height) * 0.4;
      const scale = len > cap ? cap / len : 1;
      await this.page.mouse.move(startX, startY);
      await this.page.mouse.down();
      await this.page.mouse.move(startX + px * scale, startY + py * scale, { steps: 12 });
      await this.page.mouse.up();
      await this.waitUntilIdle();
      const after = await this.getHud();
      const moved = Math.abs(after.lat - hud.lat) > 1e-7 || Math.abs(after.lng - hud.lng) > 1e-7;
      if (!moved) {
        anchorIdx += 1; // 起点压在交互图标上，换锚点
        continue;
      }
      if (!this.signChecked) {
        const movedToward =
          Math.abs(after.lng - target.lng) <= Math.abs(hud.lng - target.lng) &&
          Math.abs(after.lat - target.lat) <= Math.abs(hud.lat - target.lat);
        if (!movedToward) {
          this.dragSignX *= -1;
          this.dragSignY *= -1;
        }
        this.signChecked = true;
      }
    }
    const finalHud = await this.getHud();
    if (
      Math.abs(finalHud.lat - target.lat) > tol * 1.5 ||
      Math.abs(finalHud.lng - target.lng) > tol * 1.5
    ) {
      throw new Error(`panTo 收敛失败: 目标 ${target.lat},${target.lng} 实际 ${finalHud.lat},${finalHud.lng}`);
    }
  }

  /** Leaflet 用 <a aria-disabled> + leaflet-disabled 类表示极限级别，直接读可见属性判断。 */
  private async isButtonDisabled(selector: string): Promise<boolean> {
    const btn = this.page.locator(selector);
    const aria = await btn.getAttribute('aria-disabled').catch(() => null);
    const cls = (await btn.getAttribute('class').catch(() => null)) ?? '';
    return aria === 'true' || cls.includes('leaflet-disabled');
  }

  private async wheelZoom(deltaY: number): Promise<void> {
    const box = await this.mapEl.boundingBox();
    if (!box) throw new Error('地图容器不可见');
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.mouse.wheel(0, deltaY);
    await this.waitUntilIdle();
  }

  /** 点击可见的 + / - 缩放按钮；按钮被禁用（已到极限级别）时用滚轮兜底。 */
  async zoomIn(): Promise<void> {
    if (!(await this.isButtonDisabled('.leaflet-control-zoom-in'))) {
      await this.page.locator('.leaflet-control-zoom-in').click();
      await this.waitUntilIdle();
    } else {
      await this.wheelZoom(-260);
    }
  }

  async zoomOut(): Promise<void> {
    if (!(await this.isButtonDisabled('.leaflet-control-zoom-out'))) {
      await this.page.locator('.leaflet-control-zoom-out').click();
      await this.waitUntilIdle();
    } else {
      await this.wheelZoom(260);
    }
  }

  async setZoom(targetZoom: number): Promise<void> {
    for (let guard = 0; guard < 14; guard++) {
      const hud = await this.getHud();
      if (hud.zoom === targetZoom) return;
      const before = hud.zoom;
      if (hud.zoom < targetZoom) await this.zoomIn();
      else await this.zoomOut();
      const after = (await this.getHud()).zoom;
      if (after === before) {
        // 按钮点击未生效（极限级别/事件丢失），滚轮再试一次
        await this.wheelZoom(before < targetZoom ? -260 : 260);
      }
    }
    const finalZoom = (await this.getHud()).zoom;
    if (finalZoom !== targetZoom) throw new Error(`缩放未能到达 ${targetZoom}，实际 ${finalZoom}`);
  }

  // ---------- 可见标记枚举（仅读 DOM 外观，不读图层数据） ----------

  async listStationMarkers(): Promise<VisibleMarker[]> {
    const mapBox = await this.mapEl.boundingBox();
    if (!mapBox) return [];
    const loc = this.page.locator('[data-testid="station-marker"]');
    const out: VisibleMarker[] = [];
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const item = loc.nth(i);
      if (!(await item.isVisible())) continue;
      const b = await item.boundingBox();
      if (!b) continue;
      const x = b.x + b.width / 2 - mapBox.x;
      const y = b.y + b.height / 2 - mapBox.y;
      // 标记中心允许半图标越界（边缘标记包围盒中心可能略小于 0），
      // 但整体完全离屏（超出一个图标尺寸）的 DOM 节点无法点击，必须排除
      if (x < -b.width || y < -b.height || x > mapBox.width + b.width || y > mapBox.height + b.height) {
        continue;
      }
      const id = (await item.getAttribute('data-station-id')) ?? '';
      out.push({ id, x, y });
    }
    return out;
  }

  async listClusters(): Promise<VisibleCluster[]> {
    const mapBox = await this.mapEl.boundingBox();
    if (!mapBox) return [];
    const loc = this.page.locator('.marker-cluster');
    const out: VisibleCluster[] = [];
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const item = loc.nth(i);
      if (!(await item.isVisible())) continue;
      const b = await item.boundingBox();
      if (!b) continue;
      const x = b.x + b.width / 2 - mapBox.x;
      const y = b.y + b.height / 2 - mapBox.y;
      // 40px 聚合圆点锚点在中心，贴边时中心可能略出容器，给一个图标的余量
      if (x < -b.width || y < -b.height || x > mapBox.width + b.width || y > mapBox.height + b.height) {
        continue;
      }
      const cls = (await item.getAttribute('class')) ?? '';
      const count = Number((await item.innerText()).trim()) || 0;
      out.push({ count, x, y, stuck: cls.includes('marker-cluster-stuck') });
    }
    return out;
  }

  /** 把相对地图容器的坐标钳制到可见区域内（边缘图标中心可能略越界）。 */
  private clampToMap(x: number, y: number, box: { x: number; y: number; width: number; height: number }) {
    const cx = Math.min(Math.max(x, 2), box.width - 2);
    const cy = Math.min(Math.max(y, 2), box.height - 2);
    return { absX: box.x + cx, absY: box.y + cy };
  }

  /** 点击单个测站标记并读取详情弹窗；多轮重试，返回 null 表示被遮挡等原因未弹出。 */
  async openStationDetail(marker: VisibleMarker): Promise<Record<string, string> | null> {
    const detail = this.page.locator('[data-testid="station-detail"]');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.closePopups();
      await this.page.waitForTimeout(180); // 等弹窗关闭动画收尾，避免 leaflet-popup-tip 残留遮挡
      const mapBox = await this.mapEl.boundingBox();
      if (!mapBox) return null;

      if (attempt === 0) {
        // 第一轮用真实鼠标点击
        const { absX, absY } = this.clampToMap(marker.x, marker.y, mapBox);
        await this.page.mouse.click(absX, absY);
      } else {
        // 后续轮次直接点 DOM 元素，Playwright 会自动滚动并处理普通遮挡
        await this.page
          .locator(`[data-station-id="${marker.id}"]`)
          .first()
          .click({ timeout: 4000 })
          .catch(() => undefined);
      }
      await this.page.waitForTimeout(280);
      if (await detail.isVisible().catch(() => false)) {
        const rows = await detail.locator('td').allInnerTexts();
        const data: Record<string, string> = {};
        for (let i = 0; i + 1 < rows.length; i += 2) {
          data[rows[i].trim()] = rows[i + 1].trim();
        }
        return data;
      }
    }
    return null;
  }

  /**
   * 点击聚合。
   *  - 普通聚合：地图会放大并展开，返回 { kind: 'expanded' }
   *  - 最大级别仍重合：出现红色提示，返回 { kind: 'stuck', count }
   */
  async clickCluster(cluster: VisibleCluster): Promise<{ kind: 'expanded' } | { kind: 'stuck'; count: number }> {
    const mapBox = await this.mapEl.boundingBox();
    if (!mapBox) throw new Error('地图容器不可见');
    const { absX, absY } = this.clampToMap(cluster.x, cluster.y, mapBox);
    await this.page.mouse.click(absX, absY);
    await this.waitUntilIdle();
    const stuck = this.page.locator('[data-testid="stuck-notice"]');
    if (await stuck.isVisible().catch(() => false)) {
      const text = await stuck.innerText();
      const m = text.match(/包含\s*(\d+)\s*个/);
      const count = m ? Number(m[1]) : cluster.count;
      return { kind: 'stuck', count };
    }
    return { kind: 'expanded' };
  }

  async closePopups(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(120);
    const closeBtn = this.page.locator('.leaflet-popup-close-button:visible');
    const n = await closeBtn.count();
    for (let i = 0; i < n; i++) {
      await closeBtn.nth(i).click({ timeout: 2000 }).catch(() => undefined);
      await this.page.waitForTimeout(80);
    }
  }

  /** 用 HUD 中心与容器像素尺寸，按 Mercator 反投影估算当前视口跨度（度）。 */
  async estimateViewportSpan(): Promise<{ lat: number; lng: number; zoom: number }> {
    const hud = await this.getHud();
    const box = await this.mapEl.boundingBox();
    if (!box) throw new Error('地图容器不可见');
    const z = hud.zoom;
    const worldW = Math.pow(2, z) * 256;
    const lngSpan = (box.width / worldW) * 360;
    const cy = latToWorldY(hud.lat, z);
    const topLat = worldYToLatSafe(cy - box.height / 2, z);
    const botLat = worldYToLatSafe(cy + box.height / 2, z);
    return { lat: Math.abs(topLat - botLat), lng: lngSpan, zoom: z };
  }
}

function worldYToLatSafe(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (Math.pow(2, zoom) * 256);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// 供测试断言：本模块依赖的页面 API 白名单（防止后续改动引入隐藏接口/页面内执行）
export const ALLOWED_PAGE_APIS = [
  'locator', 'goto', 'mouse', 'keyboard', 'waitForTimeout',
];
