typedef void (*Callback)(void);

Callback make(void);
void target(void) {}

void shadowing(void) {
    Callback target = ({
        target();
        make();
    });
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
