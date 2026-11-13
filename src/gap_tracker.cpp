#include "pro20/gap_tracker.hpp"

namespace pro20 {

bool GapTracker::observe(uint16_t deviceId, uint16_t sequence) {
  DeviceGapStats& s = devices_[deviceId];

  if (!s.hasLast) {
    s.hasLast = true;
    s.lastSequence = sequence;
    s.framesReceived = 1;
    return false;
  }

  if (sequence == s.lastSequence) {
    // 上一帧原样重发：只记一次重发，不计缺号
    ++s.duplicateFrames;
    return false;
  }

  // 无符号回绕减法天然处理 65535 -> 0：此时 missing 为 0
  const uint16_t missing =
      static_cast<uint16_t>(static_cast<uint16_t>(sequence - s.lastSequence) - 1);

  ++s.framesReceived;
  s.lastSequence = sequence;

  if (missing != 0) {
    ++s.gapEvents;
    s.missingSequences += missing;
    return true;
  }
  return false;
}

}  // namespace pro20
