#include <stdio.h>

#define RETRY_DELAY_MS 250

#if defined(ENABLE_TRACE)
#define TRACE(message) fprintf(stderr, "%s\n", message)
#else
#define TRACE(message) ((void)0)
#endif

void initialize(void) {
  TRACE("initialize");
}

// This final comment is intentionally standalone.
