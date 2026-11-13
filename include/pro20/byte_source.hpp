#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace pro20 {

// 字节来源抽象：在线串口/TCP 与文件重放各自实现，下游完全不感知差异。
class ByteSource {
 public:
  virtual ~ByteSource() = default;

  // 尽量填满 out（容量由调用方给出），返回实际读到的字节数；
  // 返回 0 表示流结束（真实 EOF）或发生读取错误，二者用 hadError() 区分。
  // 允许短读。
  virtual size_t read(uint8_t* out, size_t capacity) = 0;

  // 上一次/累计读取是否发生过 I/O 错误（区别于正常 EOF）。
  // 默认无错误，由能区分 errno 的实现覆盖。
  virtual bool hadError() const { return false; }
};

// 从原始录制字节文件重放。读出来的就是当初落盘的原始字节，
// 直接喂给与在线接收相同的 FrameDecoder。
class FileByteSource : public ByteSource {
 public:
  explicit FileByteSource(const char* path);
  ~FileByteSource() override;
  FileByteSource(const FileByteSource&) = delete;
  FileByteSource& operator=(const FileByteSource&) = delete;

  size_t read(uint8_t* out, size_t capacity) override;
  bool hadError() const override { return error_; }

 private:
  int fd_ = -1;
  bool error_ = false;
};

}  // namespace pro20
