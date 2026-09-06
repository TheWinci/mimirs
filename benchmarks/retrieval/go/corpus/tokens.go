package cache

import "net"

type Token struct { ExpiresUnix int64 }
type Store struct { entries map[string]Token }

// RemoveExpired removes expired Go cache entries using Unix seconds.
func (s *Store) RemoveExpired(nowUnix int64) int {
    removed := 0
    for key, token := range s.entries {
        if token.ExpiresUnix <= nowUnix {
            delete(s.entries, key)
            removed++
        }
    }
    return removed
}

type Remote struct { connection net.Conn }
type Local struct { entries map[string]string }

// Close releases the underlying network socket.
func (r *Remote) Close() error { return r.connection.Close() }

// Close empties the local in-memory cache.
func (l *Local) Close() error { clear(l.entries); return nil }
