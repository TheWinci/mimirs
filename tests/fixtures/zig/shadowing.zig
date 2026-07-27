const Callback = *const fn () void;

fn make() Callback {}
fn target() void {}

fn shadowing() void {
    var target = target();
    target();

    target = make();
    target();

    {
        const nested = make();
        nested();
    }
    nested();

    object.callback = make();
    object();
    values[0] = make();
    values();
}
