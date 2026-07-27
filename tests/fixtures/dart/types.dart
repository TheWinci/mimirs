typedef Mapper<T> = T Function(T);

abstract class Base {}
class Alias = Base with Logging;

mixin Logging {
  void log(String value) {
    print(value);
  }
}

extension TextTools on String {
  String clean() => trim();
}

extension on int {
  int doubled() => this * 2;
}

enum State {
  idle,
  running;

  bool get active => this == running;
}
