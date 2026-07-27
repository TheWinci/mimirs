#ifdef FEATURE
#define ACTIVE() fast()
void feature() {
    ACTIVE();
}
#else
#define ACTIVE() slow()
void fallback() {
    ACTIVE();
}
#endif

void after_conditional() {
    ACTIVE();
}
