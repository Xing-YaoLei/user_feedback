#include "pro20/raw_recorder.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <stdexcept>

namespace pro20 {

RawRecorder::RawRecorder(const std::string& path) {
  fd_ = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd_ < 0) throw std::runtime_error("cannot create " + path);
}

RawRecorder::~RawRecorder() {
  if (fd_ >= 0) ::close(fd_);
}

bool RawRecorder::writeAll(const uint8_t* data, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = ::write(fd_, data + off, len - off);
    if (n <= 0) return false;  // 写入端故障：管道停机，不再向内存积压
    off += static_cast<size_t>(n);
  }
  bytesWritten_ += len;
  return true;
}

}  // namespace pro20
