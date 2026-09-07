package fixtures.control

typealias Callback = () -> Unit

class Failure {
  fun report() {}
}

fun make(): Callback = {}
fun pair(): Pair<Callback, Callback> = Pair(make(), make())
fun work() {}

fun control(
  callbacks: List<Callback>,
  pairs: List<Pair<Callback, Callback>>,
  value: Any,
) {
  for (item in callbacks) {
    item()
  }
  item()

  for ((left, right) in pairs) {
    left()
    right()
  }
  left()

  try {
    work()
  } catch (error: Failure) {
    error.report()
  }
  error.report()

  val (first, second) = pair()
  first()
  second()

  when (val selected = make()) {
    else -> selected()
  }
  selected()

  val anonymous = fun(parameter: Callback) {
    parameter()
  }
  anonymous()
}
