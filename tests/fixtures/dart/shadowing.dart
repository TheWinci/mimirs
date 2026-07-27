typedef Callback = void Function();

Callback Make() => () {};
Callback Target() => () {};

void shadowing() {
  var target = Target();
  target();

  target = Make();
  target();

  {
    final nested = Make();
    nested();
  }
  nested();

  receiver.callback = Make();
  receiver();
  values[0] = Make();
  values();

  final reference = Target;
}
