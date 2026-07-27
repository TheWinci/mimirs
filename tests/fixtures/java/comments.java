/** Utilities used by the fixture. */
package comments;

/** Coordinates work. */
class Coordinator {
    /** Current worker. */
    private final Worker worker = createWorker();

    /** Runs one unit of work. */
    @Deprecated
    void run() {
        // Keep delegation visible.
        worker.run();
    }
}
