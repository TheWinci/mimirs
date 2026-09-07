const dependency = @import("dependency.zig");

fn helper(value: u32) void {
    dependency.consume(value);
}

fn run(loader: *const fn () u32) void {
    const value = loader();
    const callback = helper;
    callback(value);
    helper(value);
    missing(value);
}
