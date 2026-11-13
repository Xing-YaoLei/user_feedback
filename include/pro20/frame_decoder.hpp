#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace pro20 {

// 一帧完整解析后的结果。readings 为有符号 16 位读数，已按小端解码。
struct Frame {
  uint16_t deviceId = 0;
  uint16_t sequence = 0;
  std::vector<int16_t> readings;
};

// 长度或 CRC 出错时的记录。offset 是该帧起始字节（A5）在整条字节流中的绝对位置。
struct DecodeError {
  enum class Kind { BadLength, BadCrc };
  uint64_t offset = 0;
  Kind kind = Kind::BadLength;
  uint16_t declaredLength = 0;
};

// 纯流式帧解码器，在线接收与文件重放共用同一个类。
//
// 帧格式：A5 5A | 长度(LE16) | 载荷(长度字节, <=256) | CRC32(LE32, 仅算载荷)
// 载荷开头：设备号(LE16) 序号(LE16)，其余为有符号 16 位读数。
//
// 输入块可以断在帧的任何位置：解码器内部持有跨块状态，直到凑齐完整帧。
// 出错帧被跳过并记录字节位置，之后从下一个 A5 5A 同步字重新找帧。
class FrameDecoder {
 public:
  using FrameCallback = std::function<void(const Frame&)>;
  using ErrorCallback = std::function<void(const DecodeError&)>;

  void onFrame(FrameCallback cb) { frameCb_ = std::move(cb); }
  void onError(ErrorCallback cb) { errorCb_ = std::move(cb); }

  // 喂入任意长度的字节块，可在帧的任意位置切断。
  void feed(const uint8_t* data, size_t len);

  // 流结束时调用：缓冲中只剩不足一帧的残数据时，按 BadLength 记录其位置。
  void finish();

  // 已喂入的字节总数（用于错误定位与测试）。
  uint64_t bytesProcessed() const { return totalBytes_; }

 private:
  enum class State { Sync0, Sync1, LenLo, LenHi, Payload, Crc };

  State state_ = State::Sync0;
  std::vector<uint8_t> buf_;
  uint16_t pendingLen_ = 0;
  size_t need_ = 0;
  uint64_t frameStart_ = 0;   // 当前帧 A5 在整条流中的绝对偏移
  uint64_t totalBytes_ = 0;

  FrameCallback frameCb_;
  ErrorCallback errorCb_;

  void resetToSync() {
    state_ = State::Sync0;
    buf_.clear();
  }
  void reportError(DecodeError::Kind kind, uint16_t declared);
};

}  // namespace pro20
