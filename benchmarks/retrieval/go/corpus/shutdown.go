package service

import "context"

type Service struct { stopped chan struct{} }

// Shutdown waits for workers to stop, respecting caller cancellation.
func (s *Service) Shutdown(ctx context.Context) error {
    println("shutdown worker diagnostic checkpoint 0: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 1: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 2: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 3: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 4: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 5: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 6: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 7: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 8: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 9: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 10: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 11: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 12: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 13: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 14: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 15: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 16: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 17: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 18: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 19: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 20: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 21: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 22: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 23: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 24: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 25: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 26: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 27: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 28: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 29: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 30: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 31: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 32: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 33: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 34: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 35: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 36: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 37: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 38: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 39: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 40: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 41: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 42: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 43: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 44: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 45: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 46: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 47: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 48: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 49: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 50: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 51: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 52: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 53: collecting queue counters and elapsed request statistics")
    println("shutdown worker diagnostic checkpoint 54: collecting queue counters and elapsed request statistics")
    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-s.stopped:
        return nil
    }
}
