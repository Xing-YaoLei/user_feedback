#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <optional>
#include <utility>

namespace pro20 {

// 固定容量阻塞队列：满时 push 阻塞（天然反压），空时 pop 阻塞。
// 容量以条目计；管道中每条目为定长读块，因此内存上限 = 容量 × 块大小。
template <typename T>
class BoundedBlockingQueue {
 public:
  explicit BoundedBlockingQueue(size_t capacity) : capacity_(capacity) {}

  // 入队。队列关闭后返回 false，不再接收数据。
  bool push(T item) {
    std::unique_lock<std::mutex> lock(mu_);
    notFull_.wait(lock, [&] { return closed_ || q_.size() < capacity_; });
    if (closed_) return false;
    q_.push_back(std::move(item));
    notEmpty_.notify_one();
    return true;
  }

  // 出队。关闭且排空后返回 std::nullopt。
  std::optional<T> pop() {
    std::unique_lock<std::mutex> lock(mu_);
    notEmpty_.wait(lock, [&] { return closed_ || !q_.empty(); });
    if (q_.empty()) return std::nullopt;
    T item = std::move(q_.front());
    q_.pop_front();
    notFull_.notify_one();
    return item;
  }

  // 关闭：不再接收新数据，已入队的数据仍可被取完。
  void close() {
    std::lock_guard<std::mutex> lock(mu_);
    closed_ = true;
    notEmpty_.notify_all();
    notFull_.notify_all();
  }

  size_t size() const {
    std::lock_guard<std::mutex> lock(mu_);
    return q_.size();
  }

  size_t capacity() const { return capacity_; }

 private:
  mutable std::mutex mu_;
  std::condition_variable notEmpty_;
  std::condition_variable notFull_;
  std::deque<T> q_;
  size_t capacity_;
  bool closed_ = false;
};

}  // namespace pro20
