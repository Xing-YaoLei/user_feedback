#pragma once

#include <cstdint>
#include <unordered_map>

namespace pro20 {

struct DeviceGapStats {
  uint64_t framesReceived = 0;   // 收到的帧数（重复帧不重复计缺号）
  uint64_t gapEvents = 0;        // 缺号事件次数
  uint64_t missingSequences = 0; // 累计缺失的序号个数
  uint64_t duplicateFrames = 0;  // 原样重发（上一帧重复）次数
  bool hasLast = false;
  uint16_t lastSequence = 0;
};

// 按设备分别统计序号缺失。
// 规则：
//   - 65535 之后接 0 视为正常连续；
//   - 与上一帧序号完全相同视为重发，只记一次 duplicate，不计缺号；
//   - 其它跳变按差值累计缺失序号并记一次缺号事件。
class GapTracker {
 public:
  // 返回 true 表示该帧相对上一帧存在缺号。
  bool observe(uint16_t deviceId, uint16_t sequence);

  const DeviceGapStats* stats(uint16_t deviceId) const {
    auto it = devices_.find(deviceId);
    return it == devices_.end() ? nullptr : &it->second;
  }

  const std::unordered_map<uint16_t, DeviceGapStats>& all() const {
    return devices_;
  }

 private:
  std::unordered_map<uint16_t, DeviceGapStats> devices_;
};

}  // namespace pro20
