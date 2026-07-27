extension type Identifier(int value) {
  String render() => value.toString();
}

enum Status { ready }

T identity<T>(T value) => value;

void modern() {
  Status status = .ready;
  int parsed = .parse("42");
  Identifier identifier = .new(7);
  final normalized = .parse("8").abs();
  identity<String>("value");

  final tearOff = identity;
  print(status);
  print(parsed);
  print(identifier.render());
  print(normalized);
  print(tearOff);
}
