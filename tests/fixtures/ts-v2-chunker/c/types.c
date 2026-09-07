typedef struct {
    int id;
    const char *name;
    unsigned active : 1;
} User;

struct Store {
    User users[10];
    void (*notify)(User *user);
};

union Value {
    int number;
    char *text;
};

enum State {
    STATE_READY,
    STATE_DONE = 4,
};

typedef int (*Comparator)(const void *left, const void *right);
typedef unsigned long Size;
