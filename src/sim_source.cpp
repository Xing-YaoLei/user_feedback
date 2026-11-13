#include "pro20/sim_source.hpp"

#include <algorithm>

#include "pro20/frame_builder.hpp"

namespace pro20 {

// 注入问题的固定位置（测试据此断言统计结果）
static constexpr size_t K_GAP_J = 40;        // 该帧序号额外 +1，制造一次缺号
static constexpr size_t K_DUP_J = 60;        // 该帧重发上一帧序号
static constexpr size_t K_CRC_J = 20;        // 该帧破坏一个载荷字节
static constexpr size_t K_GARBAGE_J = 10;    // 该帧前插入垃圾字节
static constexpr size_t K_TRUNC_J = 70;      // 该帧截断并用垃圾补齐 -> BadCrc
static constexpr uint16_t SEQ_START = 65530; // 起始序号，制造 65535->0 回绕

SimSource::SimSource(const SimConfig& cfg) {
  buildStream(cfg);
}

void SimSource::buildStream(const SimConfig& cfg) {
  std::mt19937 rng(cfg.seed);
  // 垃圾字节刻意避开 0xA5，保证不会偶发拼出伪同步字而吞掉后续好帧
  std::uniform_int_distribution<int> byteDist(0x00, 0xA4);
  std::uniform_int_distribution<int> readingDist(-30000, 30000);

  auto emitGarbage = [&](size_t n) {
    for (size_t i = 0; i < n; ++i)
      stream_.push_back(static_cast<uint8_t>(byteDist(rng)));
  };

  // 期望统计（供外部测试核对）。设备轮询交织，每台设备各自经历相同序号轨迹。
  for (size_t j = 0; j < cfg.framesPerDevice; ++j) {
    for (unsigned d = 0; d < cfg.devices; ++d) {
      const uint16_t deviceId = static_cast<uint16_t>(100 + d);

      uint32_t rawSeq = static_cast<uint32_t>(SEQ_START) + static_cast<uint32_t>(j);
      if (j == K_GAP_J) rawSeq += 1;  // 每台设备都跳过一个序号
      if (j == K_DUP_J) rawSeq -= 1;  // 每台设备都重发上一帧序号
      const uint16_t seq = static_cast<uint16_t>(rawSeq);

      std::vector<int16_t> readings(cfg.readingsPerFrame);
      for (auto& v : readings) v = static_cast<int16_t>(readingDist(rng));

      std::vector<uint8_t> frame = buildFrame(deviceId, seq,
                                              readings.data(), readings.size());

      if (cfg.injectGarbage && j == K_GARBAGE_J && d == 0)
        emitGarbage(3);

      // CRC 损坏与截断只注入设备 100 的帧；重同步可能顺带吞掉其后的相邻帧，
      // 这是固定同步字协议的固有行为，测试按实际字节流断言。
      if (cfg.injectCrcErrors && j == K_CRC_J && d == 0) {
        frame[6] ^= 0xFF;  // 翻转载荷首字节，CRC 必然不匹配
      }

      if (cfg.injectTruncation && j == K_TRUNC_J && d == 0) {
        // 只发半帧，再用不含同步字的垃圾补齐到声明长度 + CRC，
        // 解码器收下整帧后 CRC 失败、记录位置并重新同步。
        const size_t half = frame.size() / 2;
        stream_.insert(stream_.end(), frame.begin(), frame.begin() + half);
        emitGarbage(frame.size() - half);
      } else {
        stream_.insert(stream_.end(), frame.begin(), frame.end());
      }
    }
  }

  if (cfg.injectTruncation) {
    // 流末尾截断：同步字 + 长度之后再无数据，finish() 应记一次 BadLength
    stream_.push_back(0xA5);
    stream_.push_back(0x5A);
    stream_.push_back(0x10);
    stream_.push_back(0x00);
    stream_.push_back(0x01);
  }
}

size_t SimSource::read(uint8_t* out, size_t capacity) {
  const size_t avail = stream_.size() - pos_;
  const size_t n = std::min(avail, capacity);
  if (n == 0) return 0;
  std::copy_n(stream_.begin() + pos_, n, out);
  pos_ += n;
  return n;
}

}  // namespace pro20
