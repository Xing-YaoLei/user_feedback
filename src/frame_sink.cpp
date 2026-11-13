#include "pro20/frame_sink.hpp"

#include <cinttypes>

namespace pro20 {

FrameSink::FrameSink(const std::string& path) {
  fp_ = std::fopen(path.c_str(), "w");
  if (!fp_) throw std::runtime_error("cannot create " + path);
}

FrameSink::~FrameSink() {
  if (fp_) std::fclose(fp_);
}

bool FrameSink::handle(const Frame& f) {
  // 先统计：tracker 反映解码器实际交付的帧，与文本落盘是否成功无关
  tracker_.observe(f.deviceId, f.sequence);
  // 磁盘慢时 fwrite 阻塞本线程，进而通过有界队列反压到读取端
  if (std::fprintf(fp_, "dev=%" PRIu16 " seq=%" PRIu16, f.deviceId,
                   f.sequence) < 0)
    return false;
  for (int16_t v : f.readings) {
    if (std::fprintf(fp_, " %" PRId16, v) < 0) return false;
  }
  if (std::fputc('\n', fp_) == EOF) return false;
  return true;
}

}  // namespace pro20
