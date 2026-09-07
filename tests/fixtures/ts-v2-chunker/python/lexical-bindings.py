def exercise_bindings(factories, resources):
    invoke = lambda callback: callback()
    defaulted = lambda callback=callback(): callback()

    eager = [factory() for factory in factories]
    filtered = [factory() for factory in factories if factory()]
    unique = {builder() for builder in factories}
    mapping = {
        key: value()
        for key, value in resources.entries()
    }
    generated = (worker() for worker in factories)
    nested = [
        inner()
        for outer in factories
        for inner in outer()
    ]
    outside = factory()

    for runner, _ in factories:
        runner()
    runner()

    with resources.open() as opened, resources.pair() as (left, right):
        opened()
        left()
        right()
    opened()

    try:
        resources.load()
    except LookupError as error:
        error()

    return invoke, defaulted, eager, filtered, unique, mapping, generated, nested, outside


def default_scope(callback=callback()):
    return callback()
