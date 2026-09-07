package fixtures.references;

import java.util.function.Supplier;

@Configure(factory = Helpers.class)
class References {
    Supplier<Widget> methodReference = Helpers::create;
    Supplier<Widget> constructorReference = Widget::new;
    Supplier<Widget> anonymous = new Supplier<>() {
        @Override
        public Widget get() {
            return create();
        }
    };

    void execute() {
        Runnable local = this::run;
        consume(local);
    }

    void run() {}
}
