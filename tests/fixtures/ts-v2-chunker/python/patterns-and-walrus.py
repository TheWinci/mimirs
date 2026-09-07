def modern_binders(value, factories):
    annotated: object
    annotated()

    del removed
    removed()

    registry["key"] = value
    del registry["old"]
    registry()

    if chosen := factories.pop():
        chosen()

    results = [
        captured()
        for item in value
        if (captured := factories.build(item))
    ]

    match value:
        case {"handler": handler} if handler():
            handler()
        case Point(callback, fallback=other):
            callback()
            other()
        case [first, *rest]:
            first()

    return captured(), results
