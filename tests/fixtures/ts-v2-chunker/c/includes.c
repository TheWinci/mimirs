#include <stdio.h>
#include "local.h"

#ifdef FEATURE
#include "feature.h"
#endif

#if defined(DEBUG) && LEVEL > 1
#include DEBUG_HEADER
#elif FALLBACK
#include "fallback.h"
#else
#include "release.h"
#endif

void print_value(const char *value) {
    printf("%s", value);
}
