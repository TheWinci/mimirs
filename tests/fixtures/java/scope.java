package fixtures.scope;

import fixtures.runner.Runner;
import static fixtures.helpers.Tools.run;

class Scope {
    void execute(Runnable run) {
        run.run();

        Runnable callback = this::helper;
        callback.run();

        helper();
        Runner.start();
        run();
        new Worker(build());
    }

    void helper() {}

    Scope copy() {
        return new Scope();
    }
}
