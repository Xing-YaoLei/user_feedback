#include "pro20/byte_source.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <stdexcept>

namespace pro20 {

FileByteSource::FileByteSource(const char* path) {
  fd_ = ::open(path, O_RDONLY);
  if (fd_ < 0) throw std::runtime_error(std::string("cannot open ") + path);
}

FileByteSource::~FileByteSource() {
  if (fd_ >= 0) ::close(fd_);
}

size_t FileByteSource::read(uint8_t* out, size_t capacity) {
  if (capacity == 0) return 0;
  ssize_t n = ::read(fd_, out, capacity);
  if (n < 0) {
    error_ = true;  // EIO/EINTR 等：标记错误，不能伪装成正常 EOF
    return 0;
  }
  return static_cast<size_t>(n);
}

}  // namespace pro20
