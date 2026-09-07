use std::collections::HashMap;
use crate::worker::{self, run, Task as Work};
use crate::model::{user::{User, Role as UserRole}, *};
use super::*;

pub fn use_imports() {
    HashMap::new();
    worker::start();
    run();
    Work::new();
    crate::worker::finish();
}

pub fn use_local_import() {
    use crate::local::run as local_run;
    local_run();
}
