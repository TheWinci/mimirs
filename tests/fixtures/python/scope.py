from package.runner import run


def execute(run: Runner = default_runner):
    return run(), Runner(), default_runner()


def start():
    return run()
