// File documentation stays separate.

/// <summary>Coordinates work.</summary>
[Obsolete]
partial class Coordinator
{
    /// <summary>The current worker.</summary>
    private readonly Worker worker = CreateWorker();

    /// <summary>Runs one unit of work.</summary>
    [Fact]
    void Run()
    {
        // Keep delegation visible.
        worker.Run();
    }
}

partial class Coordinator
{
    partial void Hook();
}
