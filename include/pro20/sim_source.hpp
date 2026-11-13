#pragma once

#include <cstdint>
#include <random>
#include <vector>

#include "pro20/byte_source.hpp"

namespace pro20 {

struct SimConfig {
  size_t framesPerDevice = 200;   // 每台设备生成的帧数
  unsigned devices = 3;           // 设备数量
  unsigned readingsPerFrame = 4; // 每帧读数个数
  // 注入的线路问题（确定性，便于测试断言）
  bool injectCrcErrors = true;    // 个别帧损坏 CRC
  bool injectGarbage = true;      // 帧间插入垃圾字节
  bool injectTruncation = true;   // 个别帧被截断后下一帧照常开始
  uint64_t seed = 20261113;
};

// 模拟采集盒：在内存中拼出完整字节流，再以任意块大小读出，
// 用于演示与"同一段数据不同切块结果一致"的测试。
class SimSource : public ByteSource {
 public:
  explicit SimSource(const SimConfig& cfg);

  // 用指定块大小读取；最后一块可能更短，流结束返回 0。
  size_t read(uint8_t* out, size_t capacity) override;

  // 测试用：直接取出整条字节流。
  const std::vector<uint8_t>& bytes() const { return stream_; }

 private:
  void buildStream(const SimConfig& cfg);

  std::vector<uint8_t> stream_;
  size_t pos_ = 0;
};

}  // namespace pro20
