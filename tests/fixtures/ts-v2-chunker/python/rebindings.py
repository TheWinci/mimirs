from package.handlers import global_handler


def use_global():
    global global_handler
    return global_handler()


def replace_global(replacement):
    global global_handler
    global_handler = replacement
    return global_handler()


def outer(handler):
    def inherited():
        nonlocal handler
        return handler()

    def replaced(replacement):
        nonlocal handler
        handler = replacement
        return handler()

    return inherited, replaced
