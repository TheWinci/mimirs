const embedded = @embedFile("assets/message.txt");
const dynamic = @embedFile(resource_path);

fn use_resource() void {
    consume(embedded);
    consume(dynamic);
}
