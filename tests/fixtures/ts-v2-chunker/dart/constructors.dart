class Point {
  final int x;
  final int y = zero();

  Point(this.x, this.y);

  Point.origin() : x = 0, y = 0 {
    initialize();
  }

  factory Point.create() => Point.origin();

  int get sum => x + y;

  set value(int next) {
    update(next);
  }

  static Point parse(String text) {
    return decode(text);
  }
}
