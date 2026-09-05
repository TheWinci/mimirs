use crate::{self, thing as renamed};
fn call<T>(x: T) {
    let local = |arg| arg;
    local(x.method::<T>(nested()));
    opaque!(not_a_call());
}
