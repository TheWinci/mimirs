// Package cache keeps recently used values.
package cache

import (
	"sync"
	"time"
)

// DefaultTTL is how long an entry lives.
const DefaultTTL = 5 * time.Minute

const (
	MaxEntries = 1000
	MinEntries = 10
)

var (
	hits   int
	misses int
)

type (
	Key   string
	Value []byte
)

// Cache stores values by key.
type Cache struct {
	mu    sync.Mutex
	items map[Key]Value
}

type Store interface {
	Get(key Key) (Value, bool)
}

// NewCache returns an empty cache.
func NewCache() *Cache {
	return &Cache{items: map[Key]Value{}}
}

// Get returns the value for key.
func (c *Cache) Get(key Key) (Value, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.items[key]
	return value, ok
}

func (c Cache) Len() int { return len(c.items) }
