cmake_minimum_required(VERSION 3.14)
project(pro20 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(pro20
  src/crc32.cpp
  src/frame_decoder.cpp
  src/gap_tracker.cpp
  src/byte_source.cpp
  src/sim_source.cpp
  src/raw_recorder.cpp
  src/frame_sink.cpp
  src/pipeline.cpp
)
target_include_directories(pro20 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(pro20 PRIVATE -Wall -Wextra -Wpedantic)

# 现场采集演示（模拟采集盒 -> 原始字节落盘 + 解码落盘）
add_executable(capture_demo app/capture_demo.cpp)
target_link_libraries(capture_demo PRIVATE pro20)

# 原始字节文件重放，与在线接收共用同一个 FrameDecoder
add_executable(replay app/replay.cpp)
target_link_libraries(replay PRIVATE pro20)

enable_testing()
add_executable(pro20_tests tests/test_main.cpp)
target_link_libraries(pro20_tests PRIVATE pro20)
add_test(NAME unit COMMAND pro20_tests)
