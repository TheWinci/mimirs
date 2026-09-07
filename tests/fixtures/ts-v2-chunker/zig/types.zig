const User = struct {
    name: []const u8,
    age: u32 = 0,
    const default_age = 18;

    pub fn init(name: []const u8) User {
        return .{ .name = name };
    }

    pub fn display(self: *const User) void {
        render(self.name);
    }
};

const State = enum(u8) {
    ready = 1,
    done,
};

const Value = union(enum) {
    integer: i64,
    float: f64,
};

const Errors = error{
    Invalid,
    Missing,
};
