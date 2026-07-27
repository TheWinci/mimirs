pub trait Runner {
    fn run(&self, value: &str) -> bool;

    fn ready(&self) -> bool {
        check_ready()
    }
}

pub struct Worker;

impl Runner for Worker {
    fn run(&self, value: &str) -> bool {
        self.validate(value)
    }
}

impl Worker {
    pub fn new() -> Self {
        Self
    }
}
