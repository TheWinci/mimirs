package windows.modern:
  enum RetryPolicy(val delayMilliseconds: Int):
    case None extends RetryPolicy(0)
    case Standard extends RetryPolicy(250)

  given Ordering[RetryPolicy] with
    def compare(left: RetryPolicy, right: RetryPolicy): Int =
      left.delayMilliseconds.compare(right.delayMilliseconds)

  extension (policy: RetryPolicy)
    def delayed: Boolean = policy.delayMilliseconds > 0

  // This final comment belongs to the package body.
