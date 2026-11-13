#pragma once

#include <cstdio>
#include <string>

#include "pro20/frame_decoder.hpp"
#include "pro20/gap_tracker.hpp"

namespace pro20 {

// 解码结果落盘（文本格式，便于人工核对），同时驱动缺号统计。
// 失败帧不进入这里；错误由 FrameDecoder 的错误回调另行记录。
class FrameSink {
 public:
  explicit FrameSink(const std::string& path);
  FrameSink(const FrameSink&) = delete;
  FrameSink& operator=(const FrameSink&) = delete;
  virtual ~FrameSink();

  // 写一帧；下游磁盘跟不上时由调用线程阻塞在此，反压逐级传到读取端。
  // 写入失败返回 false，管道随即停机。virtual 便于测试注入磁盘故障。
  virtual bool handle(const Frame& f);

  const GapTracker& tracker() const { return tracker_; }

 private:
  std::FILE* fp_ = nullptr;
  GapTracker tracker_;
};

}  // namespace pro20
