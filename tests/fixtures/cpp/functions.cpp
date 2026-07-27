int declared(int value);
extern int global_value;

inline int add(int left, int right) {
    return left + right;
}

auto make() -> Result {
    return create();
}

constexpr int LIMIT = compute();
std::function<void()> callback = handler;

int run(int value) {
    callback();
    return declared(add(value, LIMIT));
}
