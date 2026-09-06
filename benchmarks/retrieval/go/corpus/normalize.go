package links

import "strings"

// NormalizeURL removes the fragment and a trailing slash.
func NormalizeURL(raw string) string {
    base, _, _ := strings.Cut(raw, "#")
    return strings.TrimSuffix(base, "/")
}
