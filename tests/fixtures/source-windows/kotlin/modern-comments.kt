package windows.modern

sealed interface RetryPolicy {
    val delayMilliseconds: Int

    data object None : RetryPolicy {
        override val delayMilliseconds = 0
    }

    data class Delayed(
        override val delayMilliseconds: Int,
    ) : RetryPolicy
}

fun RetryPolicy.isDelayed(): Boolean = delayMilliseconds > 0

// This final comment belongs to the package body.
