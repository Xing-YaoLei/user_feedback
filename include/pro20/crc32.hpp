#pragma once

#include <cstddef>
#include <cstdint>

namespace pro20 {

// ZIP 变体 CRC32：poly=0xEDB88320（反射），初值 0xFFFFFFFF，结果异或 0xFFFFFFFF。
// 校验范围仅为帧载荷，不含帧头与 CRC 本身。
uint32_t crc32Zip(const uint8_t* data, size_t len);

}  // namespace pro20
