import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineageStore,
  BackpressureError,
  DuplicateRecordError,
  InvalidLineageError,
  LineageError,
  UnknownGenerationError,
  UnknownOffsetError,
  type RecordId,
  type Topology,
} from "../src/index.ts";

/**
 * Pipeline under test:
 *
 *   sourceA ─┐
 *            ├─ mergeM ── splitX ─┬─ sinkL
 *   sourceB ─┘                    └─ sinkR
 *
 * Two sources merge into one intermediate stage, which then fans out into two
 * terminal partitions (each sink record depends on the same split record, so
 * shared successors are exercised as well).
 */
const TOPOLOGY: Topology = {
  stages: [
    { name: "sourceA", kind: "source" },
    { name: "sourceB", kind: "source" },
    { name: "mergeM", kind: "intermediate" },
    { name: "splitX", kind: "intermediate" },
    { name: "sinkL", kind: "sink" },
    { name: "sinkR", kind: "sink" },
  ],
  edges: [
    { from: "sourceA", to: "mergeM" },
    { from: "sourceB", to: "mergeM" },
    { from: "mergeM", to: "splitX" },
    { from: "splitX", to: "sinkL" },
    { from: "splitX", to: "sinkR" },
  ],
};

const id = (
  stage: string,
  offset: number,
  generation = 0,
  partition = 0,
): RecordId => ({ stage, partition, generation, offset });

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lineage-"));
  dir = join(root, "store");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("merge-then-split pipeline: holes, filters, generation switch, restart and compaction", () => {
  const store = LineageStore.open(dir, TOPOLOGY);

  // ---------------------------------------------------------- gen0 登记
  // sourceA: A0..A3 ; sourceB: B0..B2 (连续登记，按分区)
  for (const off of [0, 1, 2, 3]) store.registerRecord(id("sourceA", off));
  for (const off of [0, 1, 2]) store.registerRecord(id("sourceB", off));

  // merge: M0 合并 A0/B0；M1 合并 A1/B1；A2 被过滤；M2 只吃 A3；B1 被过滤
  store.registerOutput(id("mergeM", 0), [id("sourceA", 0), id("sourceB", 0)]);
  store.registerOutput(id("mergeM", 1), [id("sourceA", 1), id("sourceB", 1)]);
  store.registerOutput(id("mergeM", 2), [id("sourceA", 3)]);

  // split: 每个 merge 记录产生一个 split 记录
  store.registerOutput(id("splitX", 0), [id("mergeM", 0)]);
  store.registerOutput(id("splitX", 1), [id("mergeM", 1)]);
  store.registerOutput(id("splitX", 2), [id("mergeM", 2)]);

  // split 记录各自分裂到两个终端（共享后继）
  store.registerOutput(id("sinkL", 0), [id("splitX", 0)]);
  store.registerOutput(id("sinkR", 0), [id("splitX", 0)]);
  store.registerOutput(id("sinkL", 1), [id("splitX", 1)]);
  store.registerOutput(id("sinkR", 1), [id("splitX", 1)]);
  store.registerOutput(id("sinkL", 2), [id("splitX", 2)]);
  store.registerOutput(id("sinkR", 2), [id("splitX", 2)]);

  // 封口：过滤用零后继封口显式声明。
  // B2 故意不封口——它的 merge 后继要到后面才登记，用来演示"未封口"阻挡。
  store.seal(id("sourceA", 2)); // A2 过滤（零后继封口）
  for (const off of [0, 1, 3]) store.seal(id("sourceA", off));
  for (const off of [0, 1]) store.seal(id("sourceB", off));
  for (const off of [0, 1, 2]) {
    store.seal(id("mergeM", off));
    store.seal(id("splitX", off));
    store.seal(id("sinkL", off));
    store.seal(id("sinkR", off));
  }

  // 过滤记录零后继封口即退役；有后继的 B1 则必须等下游确认
  assert.deepEqual(store.getRecordState(id("sourceA", 2)), {
    sealed: true,
    confirmed: false,
    complete: true,
  });
  assert.equal(store.getRecordState(id("sourceB", 1)).complete, false);

  // 任何终端确认之前，所有源位置都被阻挡
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 0), 0);
  assert.equal(store.getSourceCommitFrontier("sourceB", 0, 0), 0);

  const whyA0 = store.explainSourcePosition("sourceA", 0, 0, 0);
  assert.equal(whyA0.state, "blocked");
  // A0 的血缘同时到达两个终端，两个未确认终端都必须出现在原因里
  const blockerKeys = whyA0.blockers.map((b) => `${b.record.stage}${b.record.offset}:${b.reason}`);
  assert.ok(blockerKeys.includes("sinkL0:unconfirmed"));
  assert.ok(blockerKeys.includes("sinkR0:unconfirmed"));

  const whyA3 = store.explainSourcePosition("sourceA", 0, 0, 3);
  assert.equal(whyA3.state, "blocked");
  assert.ok(whyA3.blockers.some((b) => b.record.stage === "sinkL" && b.record.offset === 2));
  assert.ok(whyA3.blockers.some((b) => b.record.stage === "sinkR" && b.record.offset === 2));

  const whyB2 = store.explainSourcePosition("sourceB", 0, 0, 2);
  assert.equal(whyB2.state, "blocked");
  // B2 在 merge 阶段没有任何后继声明（未封口），原因可沿真实血缘追到未封口的 merge 空缺
  assert.ok(whyB2.blockers.some((b) => b.reason === "unsealed"));

  // ---------------------------------------------- 交错确认：制造空洞
  // 先确认 X2 这一支（A3 链路）——A 侧 0/1 仍未确认，形成空洞
  store.confirm(id("sinkL", 2));
  store.confirm(id("sinkR", 2));

  // sinkL 的离散区间报告：前沿仍为 0，offset 2 是离散确认
  const reportL = store.getSinkReport("sinkL", 0, 0);
  assert.equal(reportL.confirmedFrontier, 0);
  assert.deepEqual(reportL.intervals, [{ start: 2, end: 3 }]);
  assert.equal(reportL.maxOffset, 3);

  // A3 自身完备，但 A0 还挡着，前沿不能跳过空洞
  assert.equal(store.getRecordState(id("sourceA", 3)).complete, true);
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 0), 0);
  assert.equal(
    store.explainSourcePosition("sourceA", 0, 0, 3).state,
    "complete-pending-prefix",
  );

  // 再确认 X0 这一支（A0+B0 共享后继）
  store.confirm(id("sinkL", 0));
  store.confirm(id("sinkR", 0));

  // 共享后继规则：两个源的同一位置都因同一批终端确认而释放
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 0), 1);
  assert.equal(store.getSourceCommitFrontier("sourceB", 0, 0), 1);

  // A1 仍然阻挡（X1 未确认）；A2 已过滤完备，但必须等 A1 之后才能连续提交
  assert.equal(
    store.explainSourcePosition("sourceA", 0, 0, 1).state,
    "blocked",
  );
  const whyA1 = store.explainSourcePosition("sourceA", 0, 0, 1);
  assert.ok(whyA1.blockers.some((b) => b.record.stage === "sinkL" && b.record.offset === 1));
  assert.ok(whyA1.blockers.some((b) => b.record.stage === "sinkR" && b.record.offset === 1));

  // B 侧前沿停在 1：B1 等 X1 确认；B2 自身未封口，两个位置都继续阻挡
  assert.equal(store.explainSourcePosition("sourceB", 0, 0, 2).state, "blocked");
  assert.ok(
    store.explainSourcePosition("sourceB", 0, 0, 2).blockers.some(
      (b) => b.record.stage === "sourceB" && b.record.offset === 2 && b.reason === "unsealed",
    ),
  );

  // 补上 X1 的两个终端确认 → A 侧连续前沿越过 A1、被过滤的 A2，直达 A3 之后
  store.confirm(id("sinkL", 1));
  store.confirm(id("sinkR", 1));
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 0), 4);
  assert.equal(store.getSinkReport("sinkL", 0, 0).confirmedFrontier, 3);
  assert.deepEqual(store.getSinkReport("sinkR", 0, 0).intervals, [
    { start: 0, end: 3 },
  ]);

  // B2 的 merge 后继现在才登记并封口 —— 迟到的封口仍然合法
  store.registerOutput(id("mergeM", 3), [id("sourceB", 2)]);
  store.registerOutput(id("splitX", 3), [id("mergeM", 3)]);
  store.registerOutput(id("sinkL", 3), [id("splitX", 3)]);
  store.registerOutput(id("sinkR", 3), [id("splitX", 3)]);
  store.seal(id("sourceB", 2)); // B2 本身上游封口，声明后继已登记完毕
  store.seal(id("mergeM", 3));
  store.seal(id("splitX", 3));
  store.seal(id("sinkL", 3));
  store.seal(id("sinkR", 3));
  // B0、B1 已完备，前沿停在 2；B2 仍等终端确认
  assert.equal(store.getSourceCommitFrontier("sourceB", 0, 0), 2);

  store.confirm(id("sinkL", 3));
  store.confirm(id("sinkR", 3));
  assert.equal(store.getSourceCommitFrontier("sourceB", 0, 0), 3);

  // sinkL 此时确认了 0,1,2,3，报告为单段连续区间
  assert.deepEqual(store.getSinkReport("sinkL", 0, 0).intervals, [
    { start: 0, end: 4 },
  ]);

  // ---------------------------------------------- 世代切换：偏移复用
  // sourceA 切到 generation 1，offset 从 0 重新开始
  store.registerRecord({ stage: "sourceA", partition: 0, generation: 1, offset: 0 });
  store.registerOutput(
    { stage: "mergeM", partition: 0, generation: 1, offset: 0 },
    [{ stage: "sourceA", partition: 0, generation: 1, offset: 0 }],
  );
  store.registerOutput(
    { stage: "splitX", partition: 0, generation: 1, offset: 0 },
    [{ stage: "mergeM", partition: 0, generation: 1, offset: 0 }],
  );
  store.registerOutput(
    { stage: "sinkL", partition: 0, generation: 1, offset: 0 },
    [{ stage: "splitX", partition: 0, generation: 1, offset: 0 }],
  );
  store.registerOutput(
    { stage: "sinkR", partition: 0, generation: 1, offset: 0 },
    [{ stage: "splitX", partition: 0, generation: 1, offset: 0 }],
  );
  store.seal({ stage: "sourceA", partition: 0, generation: 1, offset: 0 });
  store.seal({ stage: "mergeM", partition: 0, generation: 1, offset: 0 });
  store.seal({ stage: "splitX", partition: 0, generation: 1, offset: 0 });
  store.seal({ stage: "sinkL", partition: 0, generation: 1, offset: 0 });
  store.seal({ stage: "sinkR", partition: 0, generation: 1, offset: 0 });

  // 旧世代的前沿不受影响；新世代从 0 开始
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 0), 4);
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 1), 0);

  // 用旧世代身份确认 offset 0 —— 新世代记录不会被误命中
  assert.equal(store.confirm({ stage: "sinkL", partition: 0, generation: 0, offset: 0 }), false);
  assert.equal(
    store.getRecordState({ stage: "sinkL", partition: 0, generation: 1, offset: 0 }).confirmed,
    false,
  );
  // 未知世代直接拒绝
  assert.throws(
    () => store.confirm({ stage: "sinkL", partition: 0, generation: 9, offset: 0 }),
    UnknownGenerationError,
  );
  // 超过已登记最大偏移也拒绝
  assert.throws(
    () => store.confirm({ stage: "sinkL", partition: 0, generation: 1, offset: 7 }),
    UnknownOffsetError,
  );

  // 新世代确认后只推进新世代前沿
  store.confirm({ stage: "sinkL", partition: 0, generation: 1, offset: 0 });
  store.confirm({ stage: "sinkR", partition: 0, generation: 1, offset: 0 });
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 1), 1);
  assert.equal(store.getSourceCommitFrontier("sourceA", 0, 0), 4);

  // 记录压缩前的全部答案，压缩后必须逐项一致
  const before = {
    a0: store.getSourceCommitFrontier("sourceA", 0, 0),
    a1: store.getSourceCommitFrontier("sourceA", 0, 1),
    b: store.getSourceCommitFrontier("sourceB", 0, 0),
    sinkL0: store.getSinkReport("sinkL", 0, 0),
    sinkR0: store.getSinkReport("sinkR", 0, 0),
    sinkL1: store.getSinkReport("sinkL", 0, 1),
  };

  // ---------------------------------------------- 重启：重放未完成血缘
  store.close();
  const reopened = LineageStore.open(dir);
  assert.equal(reopened.getSourceCommitFrontier("sourceA", 0, 0), before.a0);
  assert.equal(reopened.getSourceCommitFrontier("sourceA", 0, 1), before.a1);
  assert.equal(reopened.getSourceCommitFrontier("sourceB", 0, 0), before.b);
  assert.deepEqual(reopened.getSinkReport("sinkL", 0, 0), before.sinkL0);
  assert.deepEqual(reopened.getSinkReport("sinkR", 0, 0), before.sinkR0);
  assert.deepEqual(reopened.getSinkReport("sinkL", 0, 1), before.sinkL1);
  // 已发布的安全前沿在恢复后保持成立（rebuildDerived 会校验不回退）
  assert.equal(reopened.explainSourcePosition("sourceA", 0, 0, 0).state, "committed");
  assert.equal(reopened.getRecordState(id("sourceA", 3)).complete, true);

  // 重启后新的登记与确认仍然可用
  reopened.registerRecord({ stage: "sourceB", partition: 0, generation: 1, offset: 0 });
  assert.equal(reopened.getSourceCommitFrontier("sourceB", 0, 1), 0);
  reopened.close();

  // ---------------------------------------------- 压缩：只删摘要覆盖的事实
  const store2 = LineageStore.open(dir);
  const statsBefore = store2.getStats();
  assert.ok(statsBefore.totalRecords > 0);

  const compactStats = store2.compact();
  assert.ok(compactStats.evictedRecords > 0);
  assert.equal(compactStats.remainingRecords, statsBefore.totalRecords - compactStats.evictedRecords);

  // 压缩前后相同输入得到完全相同的前沿与终端报告
  assert.equal(store2.getSourceCommitFrontier("sourceA", 0, 0), before.a0);
  assert.equal(store2.getSourceCommitFrontier("sourceA", 0, 1), before.a1);
  assert.equal(store2.getSourceCommitFrontier("sourceB", 0, 0), before.b);
  assert.deepEqual(store2.getSinkReport("sinkL", 0, 0), before.sinkL0);
  assert.deepEqual(store2.getSinkReport("sinkR", 0, 0), before.sinkR0);
  assert.deepEqual(store2.getSinkReport("sinkL", 0, 1), before.sinkL1);

  // 被压缩掉的位置仍可解释为已提交
  assert.equal(store2.explainSourcePosition("sourceA", 0, 0, 0).state, "committed");
  assert.equal(store2.explainSourcePosition("sourceA", 0, 0, 2).state, "committed"); // 过滤位同样提交

  // 迟到确认：世代仍可识别，且对已覆盖事实是幂等 no-op
  assert.equal(store2.confirm({ stage: "sinkL", partition: 0, generation: 0, offset: 1 }), false);
  assert.deepEqual(store2.getSinkReport("sinkL", 0, 0), before.sinkL0);

  // 压缩后新世代的未完成血缘仍可继续推进
  assert.equal(store2.getSourceCommitFrontier("sourceB", 0, 1), 0);
  const statsAfter = store2.getStats();
  assert.ok(statsAfter.totalRecords < statsBefore.totalRecords);

  // 再次压缩是幂等的：没有新完备事实时不删除任何记录
  const second = store2.compact();
  assert.equal(second.evictedRecords, 0);

  // 压缩后重启，摘要随快照持久化
  store2.close();
  const store3 = LineageStore.open(dir);
  assert.equal(store3.getSourceCommitFrontier("sourceA", 0, 0), before.a0);
  assert.equal(store3.getSourceCommitFrontier("sourceB", 0, 0), before.b);
  assert.deepEqual(store3.getSinkReport("sinkL", 0, 0), before.sinkL0);
  assert.throws(
    () => store3.confirm({ stage: "sinkL", partition: 0, generation: 9, offset: 0 }),
    UnknownGenerationError,
  );
  store3.close();

  // 持久化产物确实落在本地目录
  assert.ok(existsSync(join(dir, "snapshot.json")));
  assert.ok(existsSync(join(dir, "wal.log")));
});

test("backpressure: capacity blocks new registration while seals and confirms release slots", () => {
  const smallDir = join(root, "small");
  // 容量 6：最多同时存活 6 条未完成记录
  const store = LineageStore.open(smallDir, TOPOLOGY, { capacity: 6 });

  store.registerRecord(id("sourceA", 0));
  store.registerRecord(id("sourceA", 1));
  store.registerRecord(id("sourceA", 2));
  store.registerRecord(id("sourceA", 3));
  store.registerRecord(id("sourceB", 0));
  assert.equal(store.getStats().liveRecords, 5);

  // 第 6 条仍在容量内，可以登记
  store.registerOutput(id("mergeM", 0), [id("sourceA", 0)]);
  assert.equal(store.getStats().liveRecords, 6);

  // 容量已满：新登记（无论源还是下游）一律背压
  assert.throws(() => store.registerRecord(id("sourceB", 1)), BackpressureError);
  assert.throws(() => store.registerOutput(id("mergeM", 1), [id("sourceA", 1)]), BackpressureError);
  // 被拒绝的登记没有留下任何状态（原子性）
  assert.equal(store.getStats().totalRecords, 6);
  assert.throws(() => store.getRecordState(id("sourceB", 1)), LineageError);

  // 合法封口继续释放：M0 过滤退役，A0 随之后继全部完备而退役，腾出两个槽
  store.seal(id("mergeM", 0));
  assert.equal(store.getStats().liveRecords, 5);
  store.seal(id("sourceA", 0));
  assert.equal(store.getStats().liveRecords, 4);
  store.registerOutput(id("mergeM", 1), [id("sourceA", 1)]);
  store.registerOutput(id("splitX", 0), [id("mergeM", 1)]);
  assert.equal(store.getStats().liveRecords, 6);

  // sink 路径：确认但未封口不会释放；封口 + 确认后才沿血缘逐级释放
  assert.throws(() => store.registerOutput(id("sinkL", 0), [id("splitX", 0)]), BackpressureError);
  // 过滤一个暂不使用的源记录，腾出槽位后登记恢复
  store.seal(id("sourceA", 2));
  assert.equal(store.getStats().liveRecords, 5);
  store.registerOutput(id("sinkL", 0), [id("splitX", 0)]);
  const before = store.getStats().liveRecords;
  store.confirm(id("sinkL", 0));
  assert.equal(store.getStats().liveRecords, before); // sinkL 未封口，仍是存活记录
  store.seal(id("mergeM", 1));
  store.seal(id("splitX", 0));
  assert.equal(store.getStats().liveRecords, before); // sinkL 仍未封口
  store.seal(id("sinkL", 0)); // 封口后确认事实才让终端完备，逐级释放
  assert.ok(store.getStats().liveRecords < before);
  store.close();
});

test("atomic validation: rejected registrations and seals leave no trace", () => {
  const badDir = join(root, "bad");
  const store = LineageStore.open(badDir, TOPOLOGY);
  store.registerRecord(id("sourceA", 0));

  // 未知输入
  assert.throws(
    () => store.registerOutput(id("mergeM", 0), [id("sourceB", 0)]),
    LineageError,
  );
  // 拓扑中不存在的边
  store.registerRecord(id("sourceB", 0));
  assert.throws(
    () => store.registerOutput(id("sinkL", 0), [id("sourceB", 0)]),
    InvalidLineageError,
  );
  // 重复登记
  assert.throws(() => store.registerRecord(id("sourceA", 0)), DuplicateRecordError);
  // 非连续偏移
  assert.throws(() => store.registerRecord(id("sourceA", 2)), InvalidLineageError);
  // 对不存在的记录封口
  assert.throws(() => store.seal(id("sourceA", 9)), LineageError);
  // source 阶段不能登记输出 / sink 不能被 registerRecord
  assert.throws(
    () => store.registerOutput(id("mergeM", 1), [id("mergeM", 0)]),
    LineageError,
  );

  const stats = store.getStats();
  assert.equal(stats.totalRecords, 2); // 只有 A0、B0
  const wal = readFileSync(join(badDir, "wal.log"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  // 失败的操作没有任何 WAL 痕迹
  assert.equal(wal.length, 2);

  // 封口幂等
  assert.equal(store.seal(id("sourceA", 0)), true);
  assert.equal(store.seal(id("sourceA", 0)), false);
  store.close();
});

test("topology validation rejects cycles and malformed stages", () => {
  const cyclic: Topology = {
    stages: [
      { name: "s1", kind: "source" },
      { name: "m1", kind: "intermediate" },
      { name: "m2", kind: "intermediate" },
      { name: "k1", kind: "sink" },
    ],
    edges: [
      { from: "s1", to: "m1" },
      { from: "m1", to: "m2" },
      { from: "m2", to: "m1" },
      { from: "m2", to: "k1" },
    ],
  };
  assert.throws(
    () => LineageStore.open(join(root, "cyc"), cyclic),
    LineageError,
  );

  const noSink: Topology = {
    stages: [{ name: "s1", kind: "source" }],
    edges: [],
  };
  assert.throws(
    () => LineageStore.open(join(root, "nosink"), noSink),
    LineageError,
  );
});
