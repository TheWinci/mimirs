const tools = @import("tools.zig");
const shared = @import("../shared.zig");

pub fn launch() void {
    tools.run();
    shared.start();
}
