/** Coordinates work. */
class Coordinator {
public:
    /** Runs one unit of work. */
    void run() {
        // Keep delegation visible.
        worker_.run();
    }

private:
    Worker worker_;
};
