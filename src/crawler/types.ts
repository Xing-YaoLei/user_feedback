export interface LatLng {
  lat: number;
  lng: number;
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** 从详情弹窗读到的完整测站资料，字段全部来自可见文本。 */
export interface StationRecord {
  id: string;
  name: string;
  type: string;
  status: string;
  lat: number;
  lng: number;
  elevation: number;
  installDate: string;
  firstSeenCell: string;
  collectedAt: string;
}

/** 无法进一步展开的聚合：必须显式标为未完成，禁止估算。 */
export interface UnresolvedCluster {
  key: string;
  lat: number;
  lng: number;
  visibleCount: number;
  cell: string;
  reason: string;
  detectedAt: string;
}

export interface CellState {
  id: string;
  row: number;
  col: number;
  center: LatLng;
  status: 'pending' | 'in_progress' | 'done';
  visits: number;
  stationIds: string[];
  unresolvedKeys: string[];
}

export interface PathPoint extends LatLng {
  cell: string;
  zoom: number;
  at: string;
  action: string;
}

export interface CrawlState {
  runId: string;
  startedAt: string;
  updatedAt: string;
  bbox: BBox;
  maxZoom: number;
  viewport: { width: number; height: number };
  grid: { rows: number; cols: number; stepLat: number; stepLng: number };
  cells: CellState[];
  stations: Record<string, StationRecord>;
  unresolved: Record<string, UnresolvedCluster>;
  path: PathPoint[];
  paused: boolean;
  finished: boolean;
  /** 暂停点：恢复后从这个分块继续 */
  cursor: number;
  /** 阶段一粗网格（仅全新运行时用于聚合展开）及其完成标志 */
  coarseCells?: CellState[];
  coarseDone?: boolean;
}
