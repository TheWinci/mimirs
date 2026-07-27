/** Source-window fixtures for Java package declarations. */
package windows;

import java.time.Duration;

enum RetryPolicy {
  NONE(Duration.ZERO),
  STANDARD(Duration.ofMillis(250));

  private final Duration delay;

  RetryPolicy(Duration delay) {
    this.delay = delay;
  }

  Duration delay() {
    return delay;
  }
}

// This final comment is intentionally standalone.
