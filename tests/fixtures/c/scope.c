struct Ops {
    void (*run)(void);
};

void (*global_callback)(void);

static void helper(void) {}

int execute(struct Ops *ops, int (*loader)(void)) {
    int (*callback)(void) = loader;
    helper();
    ops->run();
    loader();
    (*loader)();
    callback();
    make()->start();
    return factory().value;
}

void use_global(void) {
    global_callback();
}
