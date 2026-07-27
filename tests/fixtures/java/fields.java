package fixtures.fields;

class Configuration {
    static final String PRIMARY = loadPrimary(), SECONDARY = loadSecondary();
    private Runnable callback = () -> notifyReady();

    {
        initialize();
    }

    static {
        register();
    }

    void execute() {
        Runnable local = () -> perform();
        local.run();

        java.util.function.Function<String, String> normalize = value -> value.trim();
        normalize.apply(" value ");
    }
}
