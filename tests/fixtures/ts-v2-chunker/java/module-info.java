module fixtures.app {
    requires java.base;
    requires transitive fixtures.api;
    requires static optional.logging;

    exports fixtures.app.api;
    opens fixtures.app.internal to framework.core;
    uses fixtures.app.Service;
    provides fixtures.app.Service with fixtures.app.ServiceImpl;
}
