//! File documentation stays separate.

/// Attached to the function.
fn run() void {
    execute();
}

test "run works" {
    run();
}

test {
    helper();
}

comptime {
    register();
}
