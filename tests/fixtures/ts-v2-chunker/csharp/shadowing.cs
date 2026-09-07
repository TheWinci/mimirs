namespace Fixtures.Shadowing;

delegate void Callback();

class Shadowing
{
    Callback Make() => null!;
    Callback Target() => null!;

    void Run()
    {
        Callback target = Target();
        target();

        target = Make();
        target();

        Callback first = Make(), second = Make();
        first();
        second();

        {
            Callback nested = Make();
            nested();
        }
        nested();

        receiver.callback = Make();
        receiver();
        values[0] = Make();
        values();
    }
}
