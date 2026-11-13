#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "pro20/bounded_blocking_queue.hpp"
#include "pro20/byte_source.hpp"
#include "pro20/frame_decoder.hpp"
#include "pro20/frame_sink.hpp"
#include "pro20/gap_tracker.hpp"
#include "pro20/raw_recorder.hpp"

namespace pro20 {

struct PipelineConfig {
  size_t readBlockSize = 4096;       // 每次从来源读取的字节数
  size_t rawQueueChunks = 32;        // 原始块队列上限：32 × readBlockSize 字节封顶
  size_t parsedQueueFrames = 256;    // 解码帧队列上限：256 帧封顶（单帧 <= 264 字节）
  std::string rawPath;               // 原始字节录制文件
  std::string framesPath;            // 解码结果文件
  std::string errorsPath;            // 错误记录文件
};

struct PipelineStats {
  uint64_t bytesIn = 0;
  uint64_t framesOk = 0;
  uint64_t badLength = 0;
  uint64_t badCrc = 0;
};

// 三级线程 + 两级有界队列：
//   读取线程 -> [原始字节队列(有上限)] -> 解码线程（同时原始落盘）
//            -> [解码帧队列(有上限)]   -> 写入线程
// 任一队列满即阻塞上游；写入端短时跟不上时读取端自然暂停，恢复后继续，
// 任何时刻在途数据都不超过两个队列的容量之和，整班运行也不会无限积压。
class Pipeline {
 public:
  Pipeline(ByteSource& source, const PipelineConfig& cfg);

  // 测试/注入用：自定义录制器与帧落盘（例如模拟磁盘满）。所有权转移给管道。
  Pipeline(ByteSource& source, const PipelineConfig& cfg,
           std::unique_ptr<RawRecorder> recorder,
           std::unique_ptr<FrameSink> sink);

  ~Pipeline();

  void start();
  // 阻塞直到来源 EOF 且数据全部落盘，或写入失败提前停机。
  void wait();

  const PipelineStats& stats() const { return stats_; }
  // 录制器或帧落盘失败标志；原子，任意线程可读
  bool writeFailed() const { return writeFailed_.load(std::memory_order_relaxed); }
  const GapTracker& tracker() const { return sink_->tracker(); }
  const std::vector<DecodeError>& errors() const { return errors_; }

 private:
  using Chunk = std::vector<uint8_t>;

  ByteSource& source_;
  PipelineConfig cfg_;
  PipelineStats stats_;
  std::atomic<bool> writeFailed_{false};

  BoundedBlockingQueue<Chunk> rawQueue_;
  BoundedBlockingQueue<Frame> frameQueue_;

  std::unique_ptr<RawRecorder> recorder_;
  std::unique_ptr<FrameSink> sink_;
  std::FILE* errorFp_ = nullptr;

  std::thread reader_;
  std::thread decoder_;
  std::thread writer_;

  std::mutex errorMu_;
  std::vector<DecodeError> errors_;

  void readLoop();
  void decodeLoop();
  void writeLoop();
  void recordError(const DecodeError& e);
};

}  // namespace pro20
