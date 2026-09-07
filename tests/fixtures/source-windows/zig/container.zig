const ReportBook = struct {
    entries: []const Entry,

    const Entry = struct {
        title: []const u8,
        owner: ?[]const u8,
    };

    pub fn init(entries: []const Entry) ReportBook {
        return .{ .entries = entries };
    }

    pub fn render(self: ReportBook, allocator: Allocator) ![][]const u8 {
        var lines = try allocator.alloc([]const u8, self.entries.len);
        for (self.entries, 0..) |entry, index| {
            const owner = entry.owner orelse "unassigned";
            lines[index] = try formatEntry(allocator, entry.title, owner);
        }
        return lines;
    }
};
