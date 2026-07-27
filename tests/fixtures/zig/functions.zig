pub fn identity(comptime T: type, value: T) T {
    return value;
}

extern fn external(value: u32) callconv(.C) void;

fn helper(value: u32) void {
    consume(value);
}

pub fn run(loader: *const fn () u32) void {
    const value = loader();
    helper(value);
    external(value);
    @as(u64, value);
}
