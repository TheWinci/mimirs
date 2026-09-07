#include <sstream>
#include <string>

template <typename Value>
std::string format_value(const Value& value) {
  std::ostringstream output;
  output << value;
  return output.str();
}

template std::string format_value<int>(const int& value);
