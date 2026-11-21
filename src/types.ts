/**
 * 联邦路径向量路由 —— 核心类型定义
 *
 * 公告（Announcement）携带：目的地、来源身份（稳定 ID + 单调重启代次）、
 * 完整域路径（来源域 -> ... -> 公告发出域）以及单调版本号。
 */

/** 域身份：稳定 ID + 单调重启代次（restart generation） */
export interface SourceId {
  /** 稳定身份：域重启后保持不变 */
  readonly stableId: string;
  /** 重启代次：每次重启单调 +1，观察到较新代次后旧代次来源信息立即失效 */
  readonly gen: number;
}

/** 路径向量协议消息种类 */
export type MessageKind = 'announce' | 'withdraw' | 'summary' | 'request';

/** 路径公告 */
export interface Announcement {
  readonly kind: 'announce';
  /** 目的地（本域拥有或代理转发的目的地标识） */
  readonly destination: string;
  /** 来源身份 */
  readonly source: SourceId;
  /** 完整域路径，路径[0] 为来源域，路径[last] 为公告发出域 */
  readonly path: readonly string[];
  /** 累计路径代价：到达公告发出域为止的各段链路代价之和（非负整数） */
  readonly cost: number;
  /** 公告版本：同一发出域对同一目的地的每条更新严格递增 */
  readonly version: number;
}

/** 路径撤销 */
export interface Withdrawal {
  readonly kind: 'withdraw';
  readonly destination: string;
  readonly source: SourceId;
  /** 撤销复用公告版本流，版本号必须严格新于此前已接收版本才会生效 */
  readonly version: number;
}

/**
 * 摘要：邻居会话建立 / 周期保活时交换。
 * 列出本域当前可达的 (目的地, 来源身份, 版本)；对端比对后可补发 REQUEST。
 */
export interface SummaryEntry {
  readonly destination: string;
  readonly source: SourceId;
  readonly version: number;
}

export interface Summary {
  readonly kind: 'summary';
  /** 摘要发出域自身的身份与当前代次 */
  readonly speaker: SourceId;
  readonly entries: readonly SummaryEntry[];
}

/** 摘要补齐请求：请求对端重新下发指定目的地的当前公告 */
export interface Request {
  readonly kind: 'request';
  readonly destination: string;
}

export type RouteMessage = Announcement | Withdrawal | Summary | Request;

/**
 * 会话信封：传输层封装，携带发送方当前的邻居会话代次。
 * 接收方比对信封会话代次与本端记录的对端会话代次，
 * 不一致则判定为已死会话上的迟到消息并丢弃。
 */
export interface SessionEnvelope {
  /** 发送方为该邻居会话分配的会话代次 */
  readonly sessionGen: number;
  readonly payload: RouteMessage;
}

/** 邻居会话标识与状态 */
export interface NeighborSession {
  /** 邻居域稳定 ID */
  readonly neighborId: string;
  /** 本端为该会话分配的会话代次：每次重新建立单调 +1 */
  sessionGen: number;
  /** 对端为该会话分配的会话代次（用于校验入向信封） */
  peerSessionGen: number;
  /** 当前链路代价（非负整数） */
  linkCost: number;
  active: boolean;
}

/**
 * 候选路径（RIB 条目）。
 * 每条候选记录从哪个邻居学到、学到时的来源身份、版本与完整路径。
 */
export interface Candidate {
  readonly destination: string;
  /** 学习该候选的邻居域 ID */
  readonly learnedFrom: string;
  /** 来源身份（稳定 ID + 代次） */
  readonly source: SourceId;
  /** 来源域 -> ... -> 邻居域 的完整路径（不含本域） */
  readonly path: readonly string[];
  /** 邻居公告中的版本号 */
  readonly version: number;
  /** 邻居公告中携带的累计路径代价（到达邻居域为止） */
  readonly announcedCost: number;
  /** 到达邻居的链路代价 */
  linkCost: number;
}

/** 本域当前选定的最优路由（数据面转发依据） */
export interface SelectedRoute {
  readonly destination: string;
  readonly source: SourceId;
  /** 来源域 -> ... -> 本域 的完整域路径 */
  readonly fullPath: readonly string[];
  /** 路径总代价（各段链路代价之和） */
  readonly totalCost: number;
  /** 跳数 = fullPath.length - 1 */
  readonly hops: number;
  /** 本域是否为目的地拥有者（本地始发路由） */
  readonly local: boolean;
  /** 学习该路由的邻居；本地始发时为 null */
  readonly learnedFrom: string | null;
  readonly version: number;
}

/** 数据转发结果 */
export type ForwardResult =
  | { ok: true; trace: readonly string[]; destination: string }
  | {
      ok: false;
      /** 可定位的断点域：转发在该域无法继续 */
      breakDomain: string;
      /** 期望的下一跳域；无路由时为 null */
      expectedNext: string | null;
      reason: 'no-route' | 'inactive-link' | 'not-a-neighbor' | 'path-mismatch' | 'loop-detected';
      trace: readonly string[];
      destination: string;
    };
