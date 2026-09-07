// Package sample provides small examples.
package sample

// Version is the current protocol version.
const Version = 1

// Ping checks service health.
func Ping() bool {
	// A local implementation note.
	return Check()
}
