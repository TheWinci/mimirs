pub fn identity<T>(value: T) -> T {
    value
}

pub fn make_name() -> String {
    identity::<String>(String::new())
}
