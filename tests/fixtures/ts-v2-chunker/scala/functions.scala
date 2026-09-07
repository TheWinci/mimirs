package fixtures.functions

def clean(value: String): String = value.trim

def transform[A](value: A)(using context: Context): A =
  validate(value)
  value

object Functions:
  val normalize = (value: String) => clean(value)

  def run(loader: () => String): String =
    val local = (value: String) => normalize(value)
    loader()
    local(" value ")
