#define LIMIT 10
#define MAX(left, right) ((left) > (right) ? (left) : (right))
#define CALLBACK handler

#define TEMPORARY() work()
#undef TEMPORARY

int clamp(int value) {
    return MAX(value, LIMIT);
}

void run_callback(void) {
    CALLBACK();
}

void after_undef(void) {
    TEMPORARY();
}
