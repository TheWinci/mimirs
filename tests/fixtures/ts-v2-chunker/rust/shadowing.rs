fn target() {}

pub fn shadowing(factory: impl Fn() -> fn()) {
    let target = || {
        target();
    };
    target();

    let mut callback = || {};
    callback();
    callback = factory();
    callback();

    let (first, second) = (factory(), factory());
    first();
    second();

    {
        let nested = factory();
        nested();
    }
    nested();

    object.callback = factory();
    object();
    values[0] = factory();
    values();
}
