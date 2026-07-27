def greet(name: str = "world") -> str:
    return format_name(name)


async def fetch(loader):
    return await loader()


def outer(prefix):
    def inner(value):
        return normalize(value)

    return inner(prefix)


def run_plugin():
    import plugin as local_plugin
    return local_plugin.run()
