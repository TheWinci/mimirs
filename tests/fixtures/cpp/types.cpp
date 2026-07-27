struct Point {
    int x, y;
};

union Value {
    int number;
    const char *text;
};

enum class State : int {
    Ready,
    Done = 4,
};

namespace alias = app::core;
using app::core::Worker;
using namespace std;

namespace {
int hidden = 1;
}

void use_types() {
    Worker::start();
    alias::run();
    move();
}
