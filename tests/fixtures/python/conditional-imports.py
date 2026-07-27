def choose(optimized):
    if optimized:
        from package.fast import run as selected
    else:
        from package.slow import run as selected

    return selected()


def optional():
    try:
        from package.optional import load
    except ImportError:
        from package.fallback import load

    return load()
