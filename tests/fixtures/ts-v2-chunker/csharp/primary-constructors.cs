class Controller(IService service)
{
    string Run(string value)
    {
        service.Execute();
        return value.Trim();
    }
}

record Envelope(Func<string> factory)
{
    string Build() => factory();
}
