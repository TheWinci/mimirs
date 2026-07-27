macro_rules! trace {
    ($value:expr) => {
        println!("{}", $value);
    };
}

fn trace() {}

pub fn log(value: &str) {
    trace!(value);
    trace();
}
