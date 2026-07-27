#ifndef FIXTURES_API_HPP
#define FIXTURES_API_HPP

#include <memory>

namespace fixtures {
class Service {
public:
    virtual ~Service() = default;
    virtual void run() = 0;
};

std::unique_ptr<Service> make_service();
}

#endif
