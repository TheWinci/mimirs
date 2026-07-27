package fixtures.shadowing

typealias Callback = () -> Unit

fun Make(): Callback = {}
fun Target(): Callback = {}

fun shadowing() {
  var target = Target()
  target()

  target = Make()
  target()

  {
    val nested = Make()
    nested()
  }
  nested()

  receiver.callback = Make()
  receiver()
  values[0] = Make()
  values()

  val reference = ::Target
}
