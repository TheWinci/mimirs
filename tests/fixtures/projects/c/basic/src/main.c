#include "../include/api.h"

static int local(void) {
    return 1;
}

int main(void) {
    local();
    calculate(1);
    READY(1);
    return 0;
}
