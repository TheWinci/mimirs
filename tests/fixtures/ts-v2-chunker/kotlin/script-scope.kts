typealias Callback = () -> Unit

fun make(): Callback = {}

val callback = make()
callback()

fun scoped() {
  val nested = make()
  nested()
}
scoped()
nested()

val reference = ::make
