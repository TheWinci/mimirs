#ifndef REPORT_H
#define REPORT_H

/** Public report metadata. */
typedef struct {
  const char *id;
  const char *title;
} report_t;

const report_t *report_find(const char *id);
void report_format(const report_t *report, char *output, unsigned long size);

#endif
