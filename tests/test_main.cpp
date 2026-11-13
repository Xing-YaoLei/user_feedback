#include <cassert>
#include <chrono>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "pro20/bounded_blocking_queue.hpp"
#include "pro20/frame_builder.hpp"
#include "pro20/frame_decoder.hpp"
#include "pro20/gap_tracker.hpp"
#include "pro20/pipeline.hpp"
#include "pro20/raw_recorder.hpp"
#include "pro20/frame_sink.hpp"
#include "pro20/sim_source.hpp"

namespace {

int g_checks = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    ++g_checks;                                                        \
    if (!(cond)) {                                                     \
      std::fprintf(stderr, "CHECK 失败: %s (%s:%d)\n", #cond,          \
                   __FILE__, __LINE__);                                \
      std::abort();                                                    \
    }                                                                  \
  } while (0)

struct DecodeResult {
  std::vector<pro20::Frame> frames;
  std::vector<pro20::DecodeError> errors;
  pro20::GapTracker tracker;
};

// 用指定块大小解码整条字节流（块可以断在帧的任何位置）
DecodeResult decodeAll(const std::vector<uint8_t>& bytes, size_t blockSize) {
  DecodeResult r;
  pro20::FrameDecoder dec;
  dec.onFrame([&](const pro20::Frame& f) {
    r.frames.push_back(f);
    r.tracker.observe(f.deviceId, f.sequence);
  });
  dec.onError([&](const pro20::DecodeError& e) { r.errors.push_back(e); });

  for (size_t off = 0; off < bytes.size();) {
    const size_t n = std::min(blockSize, bytes.size() - off);
    dec.feed(bytes.data() + off, n);
    off += n;
  }
  dec.finish();
  return r;
}

void testSingleFrameRoundTrip() {
  const int16_t readings[] = {-1, 0, 32767, -32768};
  auto frame = pro20::buildFrame(42, 7, readings, 4);

  pro20::FrameDecoder dec;
  pro20::Frame got;
  dec.onFrame([&](const pro20::Frame& f) { got = f; });
  bool hadError = false;
  dec.onError([&](const pro20::DecodeError&) { hadError = true; });

  // 一次只喂一个字节，验证任意位置断帧
  for (uint8_t b : frame) dec.feed(&b, 1);
  dec.finish();

  CHECK(!hadError);
  CHECK(got.deviceId == 42);
  CHECK(got.sequence == 7);
  CHECK(got.readings.size() == 4);
  CHECK(got.readings[0] == -1);
  CHECK(got.readings[2] == 32767);
  CHECK(got.readings[3] == -32768);
  CHECK(dec.bytesProcessed() == frame.size());
}

void testCrcAndGarbageResync() {
  auto good = pro20::buildFrame(1, 10, nullptr, 0);
  auto bad = pro20::buildFrame(2, 11, nullptr, 0);
  bad[6] ^= 0xFF;  // 破坏载荷，CRC 失败
  auto good2 = pro20::buildFrame(3, 12, nullptr, 0);

  std::vector<uint8_t> stream;
  stream.insert(stream.end(), {0x11, 0x22, 0xA5});  // 垃圾 + 半个同步字
  stream.insert(stream.end(), good.begin(), good.end());
  stream.insert(stream.end(), bad.begin(), bad.end());
  stream.insert(stream.end(), good2.begin(), good2.end());

  auto r = decodeAll(stream, 3);  // 故意切成 3 字节小块
  CHECK(r.frames.size() == 2);
  CHECK(r.frames[0].deviceId == 1);
  CHECK(r.frames[1].deviceId == 3);
  CHECK(r.errors.size() == 1);
  CHECK(r.errors[0].kind == pro20::DecodeError::Kind::BadCrc);
  // 错误位置指向坏帧的 A5：垃圾3 + 好帧长度
  CHECK(r.errors[0].offset == 3 + good.size());
}

void testBadLength() {
  // 长度为 3（装不下设备号+序号），下一帧应能正常解析
  std::vector<uint8_t> badFrame = {0xA5, 0x5A, 0x03, 0x00, 0xAA, 0xBB, 0xCC};
  auto good = pro20::buildFrame(9, 1, nullptr, 0);
  badFrame.insert(badFrame.end(), good.begin(), good.end());

  auto r = decodeAll(badFrame, 2);
  CHECK(r.frames.size() == 1);
  CHECK(r.frames[0].deviceId == 9);
  CHECK(r.errors.size() == 1);
  CHECK(r.errors[0].kind == pro20::DecodeError::Kind::BadLength);
  CHECK(r.errors[0].offset == 0);
}

void testTruncatedTail() {
  auto good = pro20::buildFrame(5, 0, nullptr, 0);
  std::vector<uint8_t> stream(good.begin(), good.end());
  stream.insert(stream.end(), {0xA5, 0x5A, 0x10, 0x00, 0x01});  // 尾部截断

  auto r = decodeAll(stream, 5);
  CHECK(r.frames.size() == 1);
  CHECK(r.errors.size() == 1);
  CHECK(r.errors[0].kind == pro20::DecodeError::Kind::BadLength);
  CHECK(r.errors[0].offset == good.size());
}

void testTruncatedTailStaleLength() {
  // 好帧之后只来 A5 5A 就 EOF：长度字段完全缺失，declaredLength 不得沿用上一帧的值
  auto good = pro20::buildFrame(5, 0, nullptr, 0);  // 载荷长度 4
  std::vector<uint8_t> stream(good.begin(), good.end());
  stream.insert(stream.end(), {0xA5, 0x5A});

  auto r = decodeAll(stream, 7);
  CHECK(r.frames.size() == 1);
  CHECK(r.errors.size() == 1);
  CHECK(r.errors[0].kind == pro20::DecodeError::Kind::BadLength);
  CHECK(r.errors[0].declaredLength == 0);  // 不是上一帧的 4
  CHECK(r.errors[0].offset == good.size());
}

void testGapTrackerRules() {
  pro20::GapTracker t;

  CHECK(!t.observe(1, 10));       // 首帧
  CHECK(!t.observe(1, 11));       // 连续
  CHECK(t.observe(1, 14));        // 缺 12、13
  CHECK(!t.observe(1, 14));       // 原样重发，只记一次，不算缺号
  CHECK(!t.observe(1, 15));       // 连续
  CHECK(t.observe(1, 2));         // 15 -> 2 回绕，中间缺 16..65535、0、1
  CHECK(!t.observe(1, 3));        // 连续
  CHECK(!t.observe(2, 99));       // 另一台设备独立统计

  const auto* s1 = t.stats(1);
  CHECK(s1->gapEvents == 2);
  CHECK(s1->missingSequences == 2 + (65536u - 16u + 2u));
  CHECK(s1->duplicateFrames == 1);
  const auto* s2 = t.stats(2);
  CHECK(s2->framesReceived == 1 && s2->gapEvents == 0);

  // 单独验证 65535 -> 0 不算缺号
  pro20::GapTracker wrap;
  CHECK(!wrap.observe(7, 65535));
  CHECK(!wrap.observe(7, 0));
  CHECK(wrap.stats(7)->missingSequences == 0);
}

void testSyncPatternInsidePayload() {
  // 读数字节流里包含 A5 5A 模式，载荷中的伪同步字不得干扰分帧
  const int16_t readings[] = {static_cast<int16_t>(0x5AA5),
                              static_cast<int16_t>(0xA55A), -1};
  auto f1 = pro20::buildFrame(7, 1, readings, 3);
  auto f2 = pro20::buildFrame(8, 2, nullptr, 0);
  std::vector<uint8_t> stream;
  stream.insert(stream.end(), f1.begin(), f1.end());
  stream.insert(stream.end(), f2.begin(), f2.end());

  pro20::FrameDecoder dec;
  int frames = 0, errors = 0;
  pro20::Frame last;
  dec.onFrame([&](const pro20::Frame& f) {
    ++frames;
    last = f;
  });
  dec.onError([&](const pro20::DecodeError&) { ++errors; });
  for (uint8_t b : stream) dec.feed(&b, 1);  // 逐字节喂
  dec.finish();

  CHECK(frames == 2 && errors == 0);
  CHECK(last.deviceId == 8);

  // 孤立 A5 后紧跟真正的 A5 5A 帧头：第一个 A5 被跳过，帧正常解析
  auto good = pro20::buildFrame(1, 2, nullptr, 0);
  std::vector<uint8_t> withLeading = {0xA5};
  withLeading.insert(withLeading.end(), good.begin(), good.end());
  pro20::FrameDecoder dec2;
  int frames2 = 0, errors2 = 0;
  dec2.onFrame([&](const pro20::Frame& f) {
    ++frames2;
    CHECK(f.deviceId == 1 && f.sequence == 2);
  });
  dec2.onError([&](const pro20::DecodeError&) { ++errors2; });
  dec2.feed(withLeading.data(), withLeading.size());
  dec2.finish();
  CHECK(frames2 == 1 && errors2 == 0);
}

void testChunkingInvariance() {
  pro20::SimConfig cfg;
  pro20::SimSource source(cfg);
  const auto& bytes = source.bytes();

  const size_t chunks[] = {1, 2, 3, 7, 64, 257, 4096, bytes.size() + 100};
  DecodeResult ref = decodeAll(bytes, 4096);

  for (size_t block : chunks) {
    auto r = decodeAll(bytes, block);

    // 帧内容、顺序、数量与切块无关
    CHECK(r.frames.size() == ref.frames.size());
    for (size_t i = 0; i < r.frames.size(); ++i) {
      const auto& a = r.frames[i];
      const auto& b = ref.frames[i];
      CHECK(a.deviceId == b.deviceId);
      CHECK(a.sequence == b.sequence);
      CHECK(a.readings == b.readings);
    }
    // 错误数量与字节位置与切块无关
    CHECK(r.errors.size() == ref.errors.size());
    for (size_t i = 0; i < r.errors.size(); ++i) {
      CHECK(r.errors[i].offset == ref.errors[i].offset);
      CHECK(r.errors[i].kind == ref.errors[i].kind);
    }
    // 缺号统计与切块无关
    for (const auto& [id, refStats] : ref.tracker.all()) {
      const auto* s = r.tracker.stats(id);
      CHECK(s != nullptr);
      CHECK(s->gapEvents == refStats.gapEvents);
      CHECK(s->missingSequences == refStats.missingSequences);
      CHECK(s->duplicateFrames == refStats.duplicateFrames);
      CHECK(s->framesReceived == refStats.framesReceived);
    }
  }
}

void testSimExpectedStats() {
  pro20::SimConfig cfg;
  pro20::SimSource source(cfg);
  auto r = decodeAll(source.bytes(), 123);

  // 每台设备各注入 1 次缺号、1 次重发；设备 100 额外有两个坏帧（CRC、截断），
  // 重同步还会顺带吞掉紧随设备 100 之后的 101/102 各一帧（固定同步字的固有行为）。
  const auto* d100 = r.tracker.stats(100);
  const auto* d101 = r.tracker.stats(101);
  const auto* d102 = r.tracker.stats(102);

  // 重发：注入的重发帧 + 被坏帧连带吞帧后形成的同序号重复
  CHECK(d100->duplicateFrames == 2);
  CHECK(d101->duplicateFrames == 2);
  CHECK(d102->duplicateFrames == 2);

  // 设备 101/102：注入缺号 1 个 + 被相邻坏帧连带吞掉 1 帧
  CHECK(d101->gapEvents == 2 && d101->missingSequences == 2);
  CHECK(d102->gapEvents == 2 && d102->missingSequences == 2);
  CHECK(d101->framesReceived == 198);
  CHECK(d102->framesReceived == 198);

  // 设备 100：自身两个坏帧丢失 + 注入缺号 + 连带效应
  CHECK(d100->framesReceived == 196);
  CHECK(d100->gapEvents == 4 && d100->missingSequences == 4);

  // 坏帧 2 个（CRC、截断）+ 流尾截断 1 个
  CHECK(r.errors.size() == 3);
  unsigned badCrc = 0, badLen = 0;
  for (const auto& e : r.errors) {
    if (e.kind == pro20::DecodeError::Kind::BadCrc) ++badCrc;
    else ++badLen;
  }
  CHECK(badCrc == 2);
  CHECK(badLen == 1);
}

// 永不 EOF 的来源，配合极小队列，让上游必然先经历阻塞再被故障唤醒
class EndlessSource : public pro20::ByteSource {
 public:
  size_t read(uint8_t* out, size_t cap) override {
    for (size_t i = 0; i < cap; ++i) out[i] = 0;
    return cap;
  }
};

class FlakyRecorder : public pro20::RawRecorder {
 public:
  FlakyRecorder() : pro20::RawRecorder("/tmp/pro20_flaky_raw.bin") {}
  bool writeAll(const uint8_t* d, size_t n) override {
    if (calls_++ >= 2) return false;  // 第 3 次写入起失败，模拟磁盘满
    return pro20::RawRecorder::writeAll(d, n);
  }

 private:
  size_t calls_ = 0;
};

class FlakySink : public pro20::FrameSink {
 public:
  FlakySink() : pro20::FrameSink("/tmp/pro20_flaky_frames.txt") {}
  bool handle(const pro20::Frame& f) override {
    if (handled_++ >= 2) return false;
    return pro20::FrameSink::handle(f);
  }

 private:
  size_t handled_ = 0;
};

// 读取即报错的来源：管道必须把它与正常 EOF 区分开，标记 writeFailed
class ErrorSource : public pro20::ByteSource {
 public:
  size_t read(uint8_t*, size_t) override {
    failed_ = true;
    return 0;
  }
  bool hadError() const override { return failed_; }

 private:
  bool failed_ = false;
};

// 带看门狗的停机测试：任何线程死锁都会超时 abort
static void runWithWatchdog(const std::function<void()>& body) {
  std::atomic<bool> done{false};
  std::thread dog([&] {
    for (int i = 0; i < 40 && !done.load(); ++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    if (!done.load()) {
      std::fprintf(stderr, "看门狗超时：管道停机死锁\n");
      std::abort();
    }
  });
  body();
  done = true;
  dog.join();
}

void testPipelineFeedsGapTracker() {
  // 回归：FrameSink 必须把每帧交给 GapTracker，生产管道的统计不能为空
  pro20::SimSource src(pro20::SimConfig{});
  pro20::PipelineConfig cfg;
  cfg.readBlockSize = 37;
  cfg.rawQueueChunks = 4;
  cfg.parsedQueueFrames = 8;
  cfg.rawPath = "/tmp/pro20_tracker_raw.bin";
  cfg.framesPath = "/tmp/pro20_tracker_frames.txt";
  cfg.errorsPath = "/tmp/pro20_tracker_err.txt";
  pro20::Pipeline pipe(src, cfg);
  runWithWatchdog([&] {
    pipe.start();
    pipe.wait();
  });
  CHECK(!pipe.writeFailed());
  const auto& all = pipe.tracker().all();
  CHECK(all.size() == 3);  // 三台设备都应出现
  for (uint16_t id : {100, 101, 102}) {
    const auto* s = pipe.tracker().stats(id);
    CHECK(s != nullptr);
    CHECK(s->framesReceived > 0);
  }
}

void testPipelineShutdownOnReadError() {
  ErrorSource src;
  pro20::PipelineConfig cfg;
  cfg.readBlockSize = 16;
  cfg.rawQueueChunks = 2;
  cfg.parsedQueueFrames = 2;
  cfg.rawPath = "/tmp/pro20_readerr_raw.bin";
  cfg.framesPath = "/tmp/pro20_readerr_frames.txt";
  cfg.errorsPath = "/tmp/pro20_readerr_err.txt";
  pro20::Pipeline pipe(src, cfg);
  runWithWatchdog([&] {
    pipe.start();
    pipe.wait();
  });
  CHECK(pipe.writeFailed());   // 读取错误不能被当成正常 EOF
  CHECK(pipe.stats().bytesIn == 0);
}

void testPipelineShutdownOnDiskFailure() {
  {
    EndlessSource src;
    pro20::PipelineConfig cfg;
    cfg.readBlockSize = 32;
    cfg.rawQueueChunks = 2;
    cfg.parsedQueueFrames = 2;
    cfg.errorsPath = "/tmp/pro20_flaky_err1.txt";
    pro20::Pipeline pipe(src, cfg, std::make_unique<FlakyRecorder>(),
                         std::make_unique<pro20::FrameSink>(
                             "/tmp/pro20_flaky_frames_a.txt"));
    runWithWatchdog([&] {
      pipe.start();
      pipe.wait();
    });
    CHECK(pipe.writeFailed());
  }
  {
    // 注意：全零字节流不是合法帧，sink 不会被调用，因此 sink 故障路径
    // 用真实模拟数据源（含合法帧）驱动
    pro20::SimSource src(pro20::SimConfig{});
    pro20::PipelineConfig cfg;
    cfg.readBlockSize = 16;
    cfg.rawQueueChunks = 2;
    cfg.parsedQueueFrames = 2;
    cfg.errorsPath = "/tmp/pro20_flaky_err2.txt";
    pro20::Pipeline pipe(src, cfg,
                         std::make_unique<pro20::RawRecorder>(
                             "/tmp/pro20_flaky_raw_b.bin"),
                         std::make_unique<FlakySink>());
    runWithWatchdog([&] {
      pipe.start();
      pipe.wait();
    });
    CHECK(pipe.writeFailed());
  }
}

void testBoundedQueueBlocksAndDrain() {
  pro20::BoundedBlockingQueue<int> q(2);
  CHECK(q.push(1));
  CHECK(q.push(2));

  // 队列满，push 必须阻塞；排空一项后自动恢复
  std::atomic<bool> pushed{false};
  std::atomic<bool> pushOk{false};
  std::thread producer([&] {
    pushOk = q.push(3);  // 满则阻塞在此，不触碰全局断言计数器
    pushed = true;
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(!pushed.load());  // 反压生效
  auto v = q.pop();
  CHECK(v.has_value() && *v == 1);
  producer.join();
  CHECK(pushed.load() && pushOk.load());

  // close 后排空剩余条目，再 pop 返回 nullopt
  q.close();
  CHECK(q.pop().value() == 2);
  CHECK(q.pop().value() == 3);
  CHECK(!q.pop().has_value());
  CHECK(!q.push(4));  // 关闭后拒绝入队
}

}  // namespace

int main() {
  testSingleFrameRoundTrip();
  testCrcAndGarbageResync();
  testBadLength();
  testTruncatedTail();
  testTruncatedTailStaleLength();
  testSyncPatternInsidePayload();
  testGapTrackerRules();
  testChunkingInvariance();
  testSimExpectedStats();
  testBoundedQueueBlocksAndDrain();
  testPipelineFeedsGapTracker();
  testPipelineShutdownOnReadError();
  testPipelineShutdownOnDiskFailure();
  std::printf("全部测试通过（%d 项断言）\n", g_checks);
  return 0;
}
