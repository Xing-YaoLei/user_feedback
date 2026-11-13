#include "pro20/frame_decoder.hpp"

#include <cstring>

#include "pro20/crc32.hpp"

namespace pro20 {

static constexpr uint8_t SYNC0 = 0xA5;
static constexpr uint8_t SYNC1 = 0x5A;
static constexpr size_t MAX_PAYLOAD = 256;
static constexpr size_t HEADER_LEN = 4;  // 设备号 + 序号

void FrameDecoder::reportError(DecodeError::Kind kind, uint16_t declared) {
  if (errorCb_) {
    DecodeError e;
    e.offset = frameStart_;
    e.kind = kind;
    e.declaredLength = declared;
    errorCb_(e);
  }
}

void FrameDecoder::feed(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; ++i) {
    const uint8_t b = data[i];
    ++totalBytes_;

    switch (state_) {
      case State::Sync0:
        if (b == SYNC0) {
          frameStart_ = totalBytes_ - 1;  // A5 的绝对偏移（0 基）
          pendingLen_ = 0;                // 新帧开始，清掉上一帧的残留长度
          state_ = State::Sync1;
        }
        break;

      case State::Sync1:
        if (b == SYNC1) {
          state_ = State::LenLo;
        } else if (b == SYNC0) {
          // A5 A5 ...：后一个 A5 仍可能是同步字起点
          frameStart_ = totalBytes_ - 1;
        } else {
          state_ = State::Sync0;
        }
        break;

      case State::LenLo:
        pendingLen_ = b;
        state_ = State::LenHi;
        break;

      case State::LenHi: {
        pendingLen_ |= static_cast<uint16_t>(b) << 8;
        // 载荷至少要装得下设备号和序号，且不超过 256 字节
        if (pendingLen_ < HEADER_LEN || pendingLen_ > MAX_PAYLOAD) {
          reportError(DecodeError::Kind::BadLength, pendingLen_);
          resetToSync();
          break;
        }
        need_ = pendingLen_;
        buf_.clear();
        buf_.reserve(need_ + 4);
        state_ = State::Payload;
        break;
      }

      case State::Payload:
        buf_.push_back(b);
        if (buf_.size() == need_) state_ = State::Crc;
        break;

      case State::Crc:
        buf_.push_back(b);
        if (buf_.size() == need_ + 4) {
          const uint32_t gotCrc =
              static_cast<uint32_t>(buf_[need_]) |
              (static_cast<uint32_t>(buf_[need_ + 1]) << 8) |
              (static_cast<uint32_t>(buf_[need_ + 2]) << 16) |
              (static_cast<uint32_t>(buf_[need_ + 3]) << 24);
          const uint32_t wantCrc = crc32Zip(buf_.data(), need_);

          if (gotCrc != wantCrc) {
            reportError(DecodeError::Kind::BadCrc, pendingLen_);
          } else if (frameCb_) {
            Frame f;
            f.deviceId = static_cast<uint16_t>(buf_[0] | (buf_[1] << 8));
            f.sequence = static_cast<uint16_t>(buf_[2] | (buf_[3] << 8));
            f.readings.resize((need_ - HEADER_LEN) / 2);
            for (size_t k = 0; k < f.readings.size(); ++k) {
              const size_t p = HEADER_LEN + k * 2;
              f.readings[k] = static_cast<int16_t>(
                  static_cast<uint16_t>(buf_[p] | (buf_[p + 1] << 8)));
            }
            frameCb_(f);
          }
          resetToSync();
        }
        break;
    }
  }
}

void FrameDecoder::finish() {
  // 流结束时仍停在同步字之后的状态，说明最后一帧被截断
  if (state_ != State::Sync0) {
    reportError(DecodeError::Kind::BadLength, pendingLen_);
    resetToSync();
  }
}

}  // namespace pro20
