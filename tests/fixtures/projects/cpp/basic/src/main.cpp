#include "../include/api.hpp"

using api::run;
namespace service = api;

static int local() {
    return 1;
}

int main() {
    local();
    run();
    api::run();
    service::Worker::create();
    READY(1);
    return 0;
}
