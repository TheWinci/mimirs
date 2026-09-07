int declared(int value);

static inline int helper(int value) {
    return value + 1;
}

char *find(const char *name) {
    return lookup(name);
}

int run(int input) {
    return declared(helper(input));
}
