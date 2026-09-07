static const int LIMIT = 10, RETRIES = 2;
extern char *message;
int values[4];

void handler(void) {}

void execute(void) {
    int local = make();
    void (*callback)(void) = handler;
    callback();
    handler();
    consume(local);
}
