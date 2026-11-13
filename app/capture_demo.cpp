// 现场采集演示：模拟采集盒 -> 原始字节落盘 + 在线解码落盘（同一套管道）
//
// 用法: capture_demo [输出目录]
#include <cstdio>
#include <string>

#include "pro20/pipeline.hpp"
#include "pro20/sim_source.hpp"

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : ".";

  pro20::SimConfig sim;
  pro20::SimSource source(sim);

  pro20::PipelineConfig cfg;
  cfg.rawPath = dir + "/raw.bin";
  cfg.framesPath = dir + "/frames.txt";
  cfg.errorsPath = dir + "/errors.txt";

  pro20::Pipeline pipe(source, cfg);
  pipe.start();
  pipe.wait();

  const auto& st = pipe.stats();
  std::printf("采集结束: 输入字节=%llu 好帧=%llu 长度错误=%llu CRC错误=%llu 写入失败=%d\n",
              static_cast<unsigned long long>(st.bytesIn),
              static_cast<unsigned long long>(st.framesOk),
              static_cast<unsigned long long>(st.badLength),
              static_cast<unsigned long long>(st.badCrc),
              pipe.writeFailed() ? 1 : 0);

  for (const auto& [id, s] : pipe.tracker().all()) {
    std::printf("设备 %u: 收帧=%llu 缺号事件=%llu 缺失序号=%llu 重发=%llu\n",
                id, static_cast<unsigned long long>(s.framesReceived),
                static_cast<unsigned long long>(s.gapEvents),
                static_cast<unsigned long long>(s.missingSequences),
                static_cast<unsigned long long>(s.duplicateFrames));
  }
  return pipe.writeFailed() ? 1 : 0;
}
