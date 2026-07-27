namespace Windows.Models;

public interface IRetryPolicy
{
    int DelayMilliseconds { get; }
}

public readonly record struct RetryPolicy(int DelayMilliseconds)
    : IRetryPolicy
{
    public static RetryPolicy Standard => new(250);
}

// This final comment is intentionally standalone.
