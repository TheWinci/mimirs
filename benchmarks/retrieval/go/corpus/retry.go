package retry

import "time"

// SchedulerRetry configures retry delays for the Go background scheduler.
// Jitter spreads simultaneous retries over a random interval.
// MaxDelay caps the wait; durations use time.Duration, measured in nanoseconds.
type SchedulerRetry struct {
    Jitter time.Duration
    MaxDelay time.Duration
}

// Defaults for outgoing HTTP requests.
var (
    // UserAgent identifies the client in outgoing HTTP request headers.
    UserAgent = "mimirs-go/1.0"
    ConnectTimeout = 5 * time.Second
)

const (
    Pending = iota
    Running
    Finished
)
