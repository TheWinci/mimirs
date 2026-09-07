library app.main;

import "src/tools.dart" as tools;
import "src/functions.dart" show build;
export "src/api.dart" show Api;
part "worker.dart";

void launch() {
  tools.run();
  build();
  tools.Worker();
  Missing();
}
