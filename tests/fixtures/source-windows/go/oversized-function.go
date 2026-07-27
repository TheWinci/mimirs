package windows

import (
	"sort"
	"strings"
)

type ReportRow struct {
	Title      string
	Owner      string
	Archived   bool
	CreatedAt  string
}

func BuildReport(rows []ReportRow, includeArchived bool) string {
	visible := make([]ReportRow, 0, len(rows))
	for _, row := range rows {
		if includeArchived || !row.Archived {
			visible = append(visible, row)
		}
	}

	sort.Slice(visible, func(left, right int) bool {
		return visible[left].CreatedAt < visible[right].CreatedAt
	})

	lines := make([]string, 0, len(visible))
	for _, row := range visible {
		owner := row.Owner
		if owner == "" {
			owner = "unassigned"
		}
		lines = append(lines, row.Title+" — "+owner)
	}

	return strings.Join(lines, "\n")
}
