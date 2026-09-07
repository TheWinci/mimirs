typedef void (*Callback)(void);

void control_flow(Callback (*factory)(void), Callback values[4]) {
    for (Callback loop = factory(); loop != 0; loop = factory()) {
        loop();
    }
    loop();

    for (int index = 0; index < 4; index++) {
        Callback item = values[index];
        item();
    }
    item();
}
