#include "declarations.hpp"

namespace reports {

Report::Report(std::string title) : title_(std::move(title)) {}

const std::string& Report::title() const {
  return title_;
}

}  // namespace reports
