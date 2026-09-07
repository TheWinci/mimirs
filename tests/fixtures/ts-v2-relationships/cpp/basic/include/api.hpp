#ifndef API_HPP
#define API_HPP

#define READY(value) ((value) > 0)

namespace api {
int run();

class Worker {
public:
    static Worker create();
};
}

#endif
