mod services;
mod worker;

mod inline {
    pub fn prepare() {}
}

use crate::services::runner::run as run_service;
use crate::worker::{self, run, Task};

pub fn launch() {
    inline::prepare();
    worker::start();
    run();
    run_service();
    crate::worker::finish();
    Task::new();
}
