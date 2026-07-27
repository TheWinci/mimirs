const std = @import("std");
const c = @cImport({
    @cInclude("stdio.h");
});

pub fn launch() void {
    std.debug.print("ready\n", .{});
    c.printf("ready\n");
}
