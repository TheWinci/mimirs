import "alpha.dart" show One, Two hide Two;
import "beta.dart" deferred as beta show Start;
export "gamma.dart" show Public, Internal hide Internal;
export "delta.dart" hide Private;

void run() {
  One();
  Two();
  beta.Start();
}
