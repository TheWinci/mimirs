package fixtures.scope

import vendor.Worker as ImportedWorker

class Worker(val name: String)

val callback = { value: String -> normalize(value) }
val eager = ImportedWorker.create()

fun helper(value: String): Worker = Worker(value)

fun run(factory: () -> Worker) {
  val local = { name: String -> helper(name) }
  factory()
  callback("one")
  local("two")
  helper("three")
  ImportedWorker.create()
  missing()
}
