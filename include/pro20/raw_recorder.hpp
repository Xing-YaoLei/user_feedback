#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace pro20 {

// 原始字节录制器：收到什么字节就写什么字节，不做任何转义或改写，
// 保证落盘文件可以原样重放并通过同一个 FrameDecoder 解码。
class RawRecorder {
 public:
  explicit RawRecorder(const std::string& path);
  RawRecorder(const RawRecorder&) = delete;
  RawRecorder& operator=(const RawRecorder&) = delete;
  virtual ~RawRecorder();

  // 处理短写，全部落盘后返回 true；写入失败返回 false。
  // virtual 便于测试注入磁盘故障。
  virtual bool writeAll(const uint8_t* data, size_t len);
  uint64_t bytesWritten() const { return bytesWritten_; }

 private:
  int fd_ = -1;
  uint64_t bytesWritten_ = 0;
};

}  // namespace pro20
