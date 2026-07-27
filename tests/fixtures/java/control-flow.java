package fixtures.control;

import java.util.List;

class ControlFlow {
    interface Callback {
        void run();
    }

    interface Resource extends AutoCloseable {}

    Callback make() {
        return null;
    }

    Resource open() {
        return null;
    }

    boolean ready() {
        return true;
    }

    void work() {}

    void control(List<Callback> callbacks, Object value) {
        for (Callback loop = make(); ready(); loop = make()) {
            loop.run();
        }
        loop.run();

        for (Callback item : callbacks) {
            item.run();
        }
        item.run();

        try (Resource resource = open()) {
            resource.close();
        }
        resource.close();

        try {
            work();
        } catch (RuntimeException error) {
            error.printStackTrace();
        }
        error.printStackTrace();

        if (value instanceof Callback callback) {
            callback.run();
        }
        callback.run();

        if (value instanceof Pair(Callback first, Callback second)) {
            first.run();
            second.run();
        }
        first.run();

        switch (value) {
            case Callback selected -> selected.run();
            default -> {}
        }
        selected.run();

        while (value instanceof Callback repeated) {
            repeated.run();
            break;
        }
        repeated.run();
    }
}
