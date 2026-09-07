namespace Fixtures.Types;

public record User(string Name, int Age);

public readonly record struct Point(int X, int Y);

public interface IService
{
    string Name { get; }
    void Run(string value);
}

public struct Result
{
    public bool Success { get; init; }
}

public enum State
{
    Ready,
    Done = 4,
}

public delegate void Handler(string value);
