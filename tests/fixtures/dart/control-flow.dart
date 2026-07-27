typedef Callback = String Function();

class Failure {
  String report() => "failure";
}

Callback make() => () => "ready";
bool ready() => true;
String fallback() => "fallback";
void work() {}

(Callback, Callback) pair() => (make(), make());

void control(
  List<Callback> callbacks,
  List<(Callback, Callback)> pairs,
  Object value,
) {
  for (var loop = make(); ready(); loop = make()) {
    loop();
  }
  loop();

  for (final item in callbacks) {
    item();
  }
  item();

  for (final (left, right) in pairs) {
    left();
    right();
  }
  left();

  try {
    work();
  } on Failure catch (error, stack) {
    error.report();
    stack.toString();
  }
  error.report();
  stack.toString();

  var (first, second) = pair();
  first();
  second();

  if (value case Callback selected) {
    selected();
  }
  selected();

  switch (value) {
    case Callback matched when ready():
      matched();
      break;
    default:
      break;
  }
  matched();

  final rendered = switch (value) {
    Callback chosen => chosen(),
    _ => fallback(),
  };
  chosen();
  print(rendered);
}
