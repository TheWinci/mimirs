const std = @import("std");
const local = @import("local.zig");
const c = @cImport({
    @cInclude("stdio.h");
});
const dynamic = @import(module_path);

pub fn run(value: u32) void {
    std.debug.print("{}", .{value});
    local.execute(value);
    c.printf("value");
}
