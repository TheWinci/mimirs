package fixtures.functions

fun load(): String = readValue()

fun String.normalized(): String = clean(this)

fun <T> transform(value: T, mapper: (T) -> T): T {
  val local = { item: T -> mapper(item) }
  return local(value)
}

fun run(loader: () -> String, items: List<String>, service: Service?) {
  loader()
  load()
  items.map { item -> item.normalized() }
  service?.refresh()
  transform<String>("value") { value -> value.trim() }
}
