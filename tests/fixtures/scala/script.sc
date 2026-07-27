import scala.util.Try

val input = args.headOption.getOrElse("42")

def parse(value: String): Int =
  Try(value.toInt).getOrElse(0)

println(parse(input))
