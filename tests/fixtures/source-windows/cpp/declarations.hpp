#pragma once

#include <string>

namespace reports {

class Report {
 public:
  explicit Report(std::string title);
  [[nodiscard]] const std::string& title() const;

 private:
  std::string title_;
};

}  // namespace reports
