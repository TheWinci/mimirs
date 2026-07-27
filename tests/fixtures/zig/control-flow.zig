const Callback = *const fn () void;

fn consume(value: anytype) void {}
fn next() ?Callback {
    return null;
}

fn control_flow(
    optional: ?Callback,
    callbacks: []Callback,
    result: anyerror!Callback,
    value: anytype,
) void {
    if (optional) |callback| {
        callback();
    }
    callback();

    if (result) |callback| {
        callback();
    } else |err| {
        consume(err);
    }
    callback();
    consume(err);

    for (callbacks, 0..) |callback, index| {
        callback();
        consume(index);
    }
    callback();
    consume(index);

    while (next()) |callback| {
        callback();
    }
    callback();

    switch (value) {
        .some => |callback| callback(),
        else => |other| other(),
    }
    callback();
    other();

    const recovered = result catch |err| {
        consume(err);
        return;
    };
    recovered();
    consume(err);
}
