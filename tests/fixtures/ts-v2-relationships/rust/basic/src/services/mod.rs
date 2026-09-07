pub mod runner;

use self::runner::run;

pub fn dispatch() {
    run();
    super::worker::finish();
}
