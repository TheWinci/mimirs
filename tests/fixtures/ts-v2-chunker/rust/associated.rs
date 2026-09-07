pub enum State {
    Done(String),
}

pub struct Worker;

impl Worker {
    pub fn new() -> Self {
        Self::helper();
        Worker
    }

    fn helper() {}

    pub fn execute(&self) {
        self.helper();
    }
}

pub trait Runner {
    fn execute(&self);
}

impl Runner for Worker {
    fn execute(&self) {
        self.helper();
    }
}

pub fn associated(worker: Worker) {
    State::Done(String::new());
    Worker::new();
    worker.execute();
    Runner::execute(&worker);
}
