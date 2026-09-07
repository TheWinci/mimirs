int square(int value) => multiply(value, value);

const limit = 10;
final callback = (String value) => normalize(value);
var name = "worker";

void main() {
  final result = callback("value");

  void nested() {
    save(result);
  }

  nested();
}
