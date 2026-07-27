void run(Service service, Loader loader) {
  final value = loader.load();
  final callback = (String item) => service.execute(item);
  callback(value);
  missing();
}
