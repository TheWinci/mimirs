package fixtures.shadowing;

class Shadowing {
    interface Callback {
        void run();
    }

    Callback make() {
        return null;
    }

    Callback target() {
        return null;
    }

    void shadowing() {
        Callback target = target();
        target.run();

        target = make();
        target.run();

        Callback first = make(), second = make();
        first.run();
        second.run();

        {
            Callback nested = make();
            nested.run();
        }
        nested.run();

        object.callback = make();
        object.run();
        values[0] = make();
        values.run();
    }
}
