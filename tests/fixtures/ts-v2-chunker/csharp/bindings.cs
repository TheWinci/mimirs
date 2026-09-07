extern alias Grid;

using System.Collections.Generic;
using System.Linq;

namespace Fixtures.Bindings;

delegate string Callback();

sealed class Worker
{
    public bool IsReady() => true;
    public string Render() => "ready";
}

class Bindings
{
    (Callback, Callback) Pair() => default;

    bool TryGet(out Callback callback)
    {
        callback = null!;
        return true;
    }

    void Run(
        IEnumerable<(Callback, Callback)> pairs,
        IEnumerable<Worker> workers)
    {
        var (first, second) = Pair();
        first();
        second();

        foreach (var (left, right) in pairs)
        {
            left();
            right();
        }
        left();

        if (TryGet(out var result))
        {
            result();
        }
        result();

        var query =
            from item in workers
            let rendered = item.Render()
            join other in workers
                on rendered equals other.Render()
            into matches
            from match in matches
            where match.IsReady()
            select match.Render()
            into projected
            select projected.Render();
        item.Render();

        Grid::Tools.Factory.Create();

        Callback group = first;
    }
}
