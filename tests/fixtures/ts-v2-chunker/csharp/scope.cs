using WorkerAlias = Fixtures.Worker;

class Scope
{
    private readonly Service service = CreateService();

    void Run(Func<string> loader)
    {
        loader();
        Helper();
        service.Execute();
        WorkerAlias.Create();

        Func<string, string> normalize = value => value.Trim();
        normalize(" value ");

        string Local(string value) { return Clean(value); }
        Local("x");

        Worker worker = new Worker(Build());
        Worker other = new();
        worker?.Execute();
        worker!.Execute();
    }

    void Helper() { }
}

class Worker
{
    public static Worker Create() => new Worker();
    public void Execute() { }
}
