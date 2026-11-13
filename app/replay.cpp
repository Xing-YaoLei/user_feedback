// 原始字节重放：读取录制文件，喂给与在线接收完全相同的 FrameDecoder。
//
// 用法: replay <raw.bin> [切块大小，默认4096]
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "pro20/byte_source.hpp"
#include "pro20/frame_decoder.hpp"
#include "pro20/gap_tracker.hpp"

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "用法: %s <raw.bin> [切块大小]\n", argv[0]);
    return 2;
  }
  const size_t blockSize = argc > 2 ? static_cast<size_t>(std::atol(argv[2])) : 4096;
  if (blockSize == 0) {
    std::fprintf(stderr, "切块大小必须 > 0\n");
    return 2;
  }

  pro20::FileByteSource source(argv[1]);
  pro20::FrameDecoder decoder;
  pro20::GapTracker tracker;

  uint64_t framesOk = 0, badLength = 0, badCrc = 0;
  decoder.onFrame([&](const pro20::Frame& f) {
    ++framesOk;
    tracker.observe(f.deviceId, f.sequence);
  });
  decoder.onError([&](const pro20::DecodeError& e) {
    if (e.kind == pro20::DecodeError::Kind::BadLength) ++badLength;
    else ++badCrc;
    std::printf("错误 offset=%llu kind=%s declared=%u\n",
                static_cast<unsigned long long>(e.offset),
                e.kind == pro20::DecodeError::Kind::BadLength ? "bad_length"
                                                               : "bad_crc",
                e.declaredLength);
  });

  std::vector<uint8_t> block(blockSize);
  while (true) {
    const size_t n = source.read(block.data(), block.size());
    if (n == 0) break;
    decoder.feed(block.data(), n);  // 可断在帧的任何位置
  }
  decoder.finish();

  std::printf("重放结束(切块=%zu): 好帧=%llu 长度错误=%llu CRC错误=%llu\n",
              blockSize, static_cast<unsigned long long>(framesOk),
              static_cast<unsigned long long>(badLength),
              static_cast<unsigned long long>(badCrc));
  for (const auto& [id, s] : tracker.all()) {
    std::printf("设备 %u: 收帧=%llu 缺号事件=%llu 缺失序号=%llu 重发=%llu\n",
                id, static_cast<unsigned long long>(s.framesReceived),
                static_cast<unsigned long long>(s.gapEvents),
                static_cast<unsigned long long>(s.missingSequences),
                static_cast<unsigned long long>(s.duplicateFrames));
  }
  return 0;
}
