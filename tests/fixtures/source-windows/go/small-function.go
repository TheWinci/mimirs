// Package windows contains source-window fixtures.
package windows

// FormatAccount formats one account label for a search result.
func FormatAccount(name string, active bool) string {
	status := "disabled"
	if active {
		status = "active"
	}
	return name + " (" + status + ")"
}
