using Callback = void (*)();

void fail();

struct Error {
    void handle();
};

void control_flow(Callback (*make)(), Callback callbacks[2], auto pairs) {
    for (Callback loop = make(); loop; loop = make()) {
        loop();
    }
    loop();

    for (Callback item : callbacks) {
        item();
    }
    item();

    for (auto [first, second] : pairs) {
        first();
        second();
    }
    first();

    if (Callback handler = make(); handler) {
        handler();
    }
    handler();

    while (Callback next = make()) {
        next();
    }
    next();

    try {
        fail();
    } catch (const Error& error) {
        error.handle();
    }
    error.handle();
}
