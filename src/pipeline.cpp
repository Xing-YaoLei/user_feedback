#include "pro20/pipeline.hpp"

#include <cinttypes>
#include <cstdio>

namespace pro20 {

Pipeline::Pipeline(ByteSource& source, const PipelineConfig& cfg)
    : Pipeline(source, cfg,
               std::make_unique<RawRecorder>(cfg.rawPath),
               std::make_unique<FrameSink>(cfg.framesPath)) {}

Pipeline::Pipeline(ByteSource& source, const PipelineConfig& cfg,
                   std::unique_ptr<RawRecorder> recorder,
                   std::unique_ptr<FrameSink> sink)
    : source_(source),
      cfg_(cfg),
      rawQueue_(cfg.rawQueueChunks),
      frameQueue_(cfg.parsedQueueFrames),
      recorder_(std::move(recorder)),
      sink_(std::move(sink)) {
  errorFp_ = std::fopen(cfg.errorsPath.c_str(), "w");
  if (!errorFp_) throw std::runtime_error("cannot create " + cfg.errorsPath);
}

Pipeline::~Pipeline() {
  if (reader_.joinable()) reader_.join();
  if (decoder_.joinable()) decoder_.join();
  if (writer_.joinable()) writer_.join();
  if (errorFp_) std::fclose(errorFp_);
}

void Pipeline::recordError(const DecodeError& e) {
  {
    std::lock_guard<std::mutex> lock(errorMu_);
    errors_.push_back(e);
  }
  if (e.kind == DecodeError::Kind::BadLength)
    ++stats_.badLength;
  else
    ++stats_.badCrc;
  std::fprintf(errorFp_,
               "offset=%" PRIu64 " kind=%s declared=%" PRIu16 "\n", e.offset,
               e.kind == DecodeError::Kind::BadLength ? "bad_length" : "bad_crc",
               e.declaredLength);
}

void Pipeline::readLoop() {
  std::vector<uint8_t> block(cfg_.readBlockSize);
  while (!writeFailed_.load(std::memory_order_relaxed)) {
    const size_t n = source_.read(block.data(), block.size());
    if (n == 0) {
      if (source_.hadError()) {
        // 读取错误（区别于正常 EOF）：按故障停机，避免静默截断录制
        writeFailed_.store(true, std::memory_order_relaxed);
      }
      break;
    }
    Chunk chunk(block.begin(), block.begin() + n);
    stats_.bytesIn += n;
    // 队列满时阻塞在这里：写入端恢复后自动继续，内存占用有硬上限
    if (!rawQueue_.push(std::move(chunk))) break;
  }
  rawQueue_.close();
}

void Pipeline::decodeLoop() {
  FrameDecoder dec;
  dec.onFrame([this](const Frame& f) {
    ++stats_.framesOk;
    // 写入端失败时帧队列被关闭，push 返回 false，直接丢弃即可
    frameQueue_.push(f);
  });
  dec.onError([this](const DecodeError& e) { recordError(e); });

  while (auto maybe = rawQueue_.pop()) {
    const Chunk& chunk = *maybe;
    // 1) 原始字节原样落盘：保证文件可直接重放
    if (!recorder_->writeAll(chunk.data(), chunk.size())) {
      writeFailed_.store(true, std::memory_order_relaxed);
      // 唤醒可能正阻塞在 rawQueue_.push() 的读取线程，否则永久死锁
      rawQueue_.close();
      break;
    }
    // 2) 同一份字节喂给在线解码器
    dec.feed(chunk.data(), chunk.size());
  }
  dec.finish();  // 尾部残帧以 BadLength 记录
  frameQueue_.close();
}

void Pipeline::writeLoop() {
  while (auto maybe = frameQueue_.pop()) {
    if (!sink_->handle(*maybe)) {
      writeFailed_.store(true, std::memory_order_relaxed);
      break;
    }
  }
  // 失败路径：同时关闭两个队列，唤醒可能阻塞在 push 的读取/解码线程。
  // 正常路径下两个队列本已排空并关闭，重复关闭无害。
  rawQueue_.close();
  frameQueue_.close();
}

void Pipeline::start() {
  reader_ = std::thread([this] { readLoop(); });
  decoder_ = std::thread([this] { decodeLoop(); });
  writer_ = std::thread([this] { writeLoop(); });
}

void Pipeline::wait() {
  reader_.join();
  decoder_.join();
  writer_.join();
  std::fflush(errorFp_);
}

}  // namespace pro20
