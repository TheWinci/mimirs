#include <string>
#include <vector>

namespace windows {

class ReportBook {
 public:
  void add(std::string title, std::string owner) {
    entries_.push_back({std::move(title), std::move(owner)});
  }

  std::vector<std::string> render() const {
    std::vector<std::string> lines;
    for (const auto& entry : entries_) {
      lines.push_back(entry.title + " — " + entry.owner);
    }
    return lines;
  }

 private:
  struct Entry {
    std::string title;
    std::string owner;
  };

  std::vector<Entry> entries_;
};

}  // namespace windows
