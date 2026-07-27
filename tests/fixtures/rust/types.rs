pub const DEFAULT_LIMIT: usize = 10;
pub static ACTIVE: bool = true;

pub type Identifier = String;

pub struct Store<T> {
    pub name: String,
    items: Vec<T>,
}

pub union Number {
    integer: i64,
    decimal: f64,
}

pub enum State {
    Ready,
    Done(String),
}

pub fn finished() -> State {
    State::Done(String::new())
}
