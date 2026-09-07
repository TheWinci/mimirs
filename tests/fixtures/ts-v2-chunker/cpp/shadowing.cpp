using Callback = void (*)();

Callback make();
void target() {}

void shadowing() {
    Callback target = target();
    target();

    target = make();
    target();

    Callback first = make(), second = make();
    first();
    second();

    {
        Callback nested = make();
        nested();
    }
    nested();

    object.callback = make();
    object();
    values[0] = make();
    values();
}
