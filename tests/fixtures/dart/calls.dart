void run(Service? service, List<int> values) {
  service?.execute();
  build().start();
  values.map((value) => transform(value)).toList();

  final worker = Worker.create()
    ..prepare()
    ..start();
}
