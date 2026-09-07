package fixtures.classes;

class Worker extends BaseWorker implements Runnable {
    private final Service service;

    public Worker(Service service) {
        this.service = service;
    }

    @Override
    public void run() {
        service.execute();
    }

    private static class State {
        boolean ready() {
            return check();
        }
    }
}
