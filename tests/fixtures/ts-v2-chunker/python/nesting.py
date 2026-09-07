def build_product(prefix):
    class Product:
        def __init__(self, name):
            self.name = name

        def label(self):
            return f"{prefix}:{self.name}"

    def create(name):
        return Product(name)

    return create("sample")
