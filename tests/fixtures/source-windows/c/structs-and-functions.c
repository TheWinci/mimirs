#include <stddef.h>

typedef struct {
  const char *title;
  const char *owner;
  int archived;
} ReportEntry;

size_t report_visible_count(
    const ReportEntry *entries,
    size_t length,
    int include_archived) {
  size_t count = 0;
  for (size_t index = 0; index < length; index++) {
    if (include_archived || !entries[index].archived) {
      count++;
    }
  }
  return count;
}

const char *report_owner(const ReportEntry *entry) {
  return entry->owner == NULL ? "unassigned" : entry->owner;
}
