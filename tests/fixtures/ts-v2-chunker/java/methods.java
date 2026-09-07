package fixtures.methods;

class Processor {
    Processor() {
        this(defaultValue());
    }

    Processor(String value) {
        super();
        configure(value);
    }

    <T> T transform(T value, Mapper<T> mapper) {
        return mapper.apply(value);
    }

    static String defaultValue() {
        Processor.<String>create();
        return create();
    }

    void configure(String value) {}

    void configure(Object value) {}
}
