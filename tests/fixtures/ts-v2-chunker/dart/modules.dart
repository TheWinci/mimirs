library app.main;

import "dart:async";
import "package:app/service.dart" as service show Client;
import "src/optional.dart" if (dart.library.io) "src/io.dart";
export "src/api.dart" show Api;
part "worker.dart";

void run() {
  service.start();
}
