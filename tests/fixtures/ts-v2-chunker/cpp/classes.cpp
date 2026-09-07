namespace app::core {
class Worker final : public Base {
public:
    Worker(Service &service) : service_(service) {}

    ~Worker() {
        cleanup();
    }

    int run(int value) const {
        return service_.execute(value);
    }

    static Worker create();
    Worker &operator=(const Worker &) = delete;

private:
    Service &service_;
};

Worker Worker::create() {
    return Worker(default_service());
}
}
