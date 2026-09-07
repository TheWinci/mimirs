using System;
using System.Collections.Generic;

namespace Fixtures.Control;

delegate void Callback();

sealed class Resource : IDisposable
{
    public void Dispose() {}
}

sealed class Failure : Exception
{
    public bool IsExpected() => true;
    public void Report() {}
}

class ControlFlow
{
    Callback Make() => null!;
    Resource Open() => new();
    bool Ready() => true;
    void Work() {}

    void Control(IEnumerable<Callback> callbacks, object value)
    {
        for (Callback loop = Make(); Ready(); loop = Make())
        {
            loop();
        }
        loop();

        foreach (Callback item in callbacks)
        {
            item();
        }
        item();

        using (Resource resource = Open())
        {
            resource.Dispose();
        }
        resource.Dispose();

        try
        {
            Work();
        }
        catch (Failure error) when (error.IsExpected())
        {
            error.Report();
        }
        error.Report();

        if (value is Callback selected)
        {
            selected();
        }
        selected();

        switch (value)
        {
            case Callback matched:
                matched();
                break;
        }
        matched();

        while (value is Callback repeated)
        {
            repeated();
            break;
        }
        repeated();
    }
}
