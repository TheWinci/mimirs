class Calls {
public:
    void run(Service &service, Callback callback) {
        helper();
        service.run();
        callback();
        this->method();
        configure(1);
        Type::create();
        factory().start();

        auto local = []() {
            nested();
        };
        local();

        auto normalize = [](Value &value) {
            value.clean();
        };
        normalize(service);

        new Worker(build());
        new Calls();
    }

    void helper() {}
    void method() {}
    void configure(int value) {}
    void configure(double value) {}
};
