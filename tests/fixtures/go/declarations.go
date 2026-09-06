//go:build linux
// +build linux

// Package cache retains labels.
package cache

/* #include <stdlib.h> */
import "C"
import (
    "fmt"
    alias "io"
    . "strings"
    _ "net/http"
)

// Box keeps a value.
type Box[T any] struct {
    Value T `json:"value"`
    *Embedded
}
type Alias[T any] = Box[T]

// Shapes are reusable types.
type (
    // Reader consumes a value.
    Reader interface { Read([]byte) (int, error); ~int | ~int64 }
    Labels = map[string]string
)

// Modes describe the lifecycle.
const (
    // Idle precedes active work.
    Idle = iota
    Active
    a, b = 1, 2
    _ = 99
)
const Single int = 1
const _ = 0

var (
    // Factory retains its complete initializer.
    Factory = func() string { type Local int; var local = "café"; return local }
    x, y int = 1, 2
)
var greeting = `first
second☕`
var callback = func() { var hidden = 1; _ = hidden }

// Get returns a value.
// It leaves the box unchanged.
func (b *Box[T]) Get() (value T) { return b.Value }
func (Other) Get() string { return "other" }
func Identity[T any](value T) T { return value }
func external(x int) int
func init() {}
func init() {}
