#ifndef REPORT_STATUS_HH
#define REPORT_STATUS_HH

namespace reports {

enum class Status {
  draft,
  published,
  archived,
};

constexpr bool visible(Status status) {
  return status == Status::published;
}

}  // namespace reports

#endif
