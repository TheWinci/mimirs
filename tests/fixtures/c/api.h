#ifndef FIXTURES_API_H
#define FIXTURES_API_H

#include <stddef.h>

typedef struct Store Store;
typedef void (*StoreCallback)(Store *store);

struct Store {
    size_t size;
    StoreCallback callback;
};

Store *store_create(StoreCallback callback);
void store_destroy(Store *store);
extern const int STORE_VERSION;

#endif
