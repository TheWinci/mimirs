from package.factories import base_class, build_default, decorate


@decorate(register())
def configured(callback=build_default()) -> return_type():
    return callback()


class Configured(base_class()):
    factory = inside_class
    value = factory()

    def run(self):
        return factory()
