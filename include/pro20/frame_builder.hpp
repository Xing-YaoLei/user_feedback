#pragma once

#include <cstdint>
#include <vector>

#include "pro20/crc32.hpp"

namespace pro20 {

// 按线路格式组一帧：A5 5A | 长度 LE16 | 载荷 | CRC32 LE32。
// 载荷 = 设备号 LE16 + 序号 LE16 + 若干有符号 16 位读数 LE16。
inline std::vector<uint8_t> buildFrame(uint16_t deviceId, uint16_t sequence,
                                       const int16_t* readings,
                                       size_t readingCount) {
  const uint16_t payloadLen =
      static_cast<uint16_t>(4 + static_cast<uint32_t>(readingCount) * 2);
  std::vector<uint8_t> payload(payloadLen);
  payload[0] = static_cast<uint8_t>(deviceId);
  payload[1] = static_cast<uint8_t>(deviceId >> 8);
  payload[2] = static_cast<uint8_t>(sequence);
  payload[3] = static_cast<uint8_t>(sequence >> 8);
  for (size_t i = 0; i < readingCount; ++i) {
    auto v = static_cast<uint16_t>(readings[i]);
    payload[4 + i * 2] = static_cast<uint8_t>(v);
    payload[5 + i * 2] = static_cast<uint8_t>(v >> 8);
  }

  std::vector<uint8_t> frame;
  frame.reserve(4 + payload.size() + 4);
  frame.push_back(0xA5);
  frame.push_back(0x5A);
  frame.push_back(static_cast<uint8_t>(payloadLen));
  frame.push_back(static_cast<uint8_t>(payloadLen >> 8));
  frame.insert(frame.end(), payload.begin(), payload.end());

  const uint32_t crc = crc32Zip(payload.data(), payload.size());
  frame.push_back(static_cast<uint8_t>(crc));
  frame.push_back(static_cast<uint8_t>(crc >> 8));
  frame.push_back(static_cast<uint8_t>(crc >> 16));
  frame.push_back(static_cast<uint8_t>(crc >> 24));
  return frame;
}

}  // namespace pro20
