import 'dart:async';

const retryDelay = Duration(milliseconds: 250);

/// Return the configured retry delay.
Duration configuredDelay() => retryDelay;

Future<void> waitForRetry() async {
  await Future<void>.delayed(retryDelay);
}

// This final comment is intentionally standalone.
