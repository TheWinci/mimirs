package fixtures.types;

interface Service {
    String run(String value);

    default boolean ready() {
        return check();
    }
}

record Point(String x, String y) {
    public Point {
        x.trim();
        validate(x, y);
    }
}

enum State {
    READY,
    DONE(1) {
        void act() {}
    };

    State(int code) {}
}

@interface Marker {
    String value() default "default";
}
