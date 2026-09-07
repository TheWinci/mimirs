#include <optional>

template <typename Value>
class Cache {
 public:
  void set(Value value) { value_ = std::move(value); }
  const std::optional<Value>& get() const { return value_; }

 private:
  std::optional<Value> value_;
};

#if defined(ENABLE_CACHE_TRACE)
#define CACHE_TRACE(message) trace(message)
#else
#define CACHE_TRACE(message) ((void)0)
#endif

// This final comment is intentionally standalone.
