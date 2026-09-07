import "optional.dart" if (dart.library.io) "io.dart" as platform;

void launch() {
  platform.run();
}
