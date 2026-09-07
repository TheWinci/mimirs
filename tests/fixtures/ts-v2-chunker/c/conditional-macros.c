#ifdef FEATURE
#define ACTIVE() fast()
void feature(void) {
    ACTIVE();
}
#else
#define ACTIVE() slow()
void fallback(void) {
    ACTIVE();
}
#endif

void after_conditional(void) {
    ACTIVE();
}
