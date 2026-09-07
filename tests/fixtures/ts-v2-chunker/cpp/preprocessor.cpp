#include <vector>
#include "local.hpp"

#define APPLY(value) run(value)
#define TEMPORARY() work()
#undef TEMPORARY

#if FEATURE
void enabled() {
    APPLY(1);
    TEMPORARY();
}
#endif
