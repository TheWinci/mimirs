package fixtures.imports

import kotlin.collections.List
import vendor.Worker as ImportedWorker
import vendor.tools.*

fun create(): ImportedWorker {
  List(1) { ImportedWorker.create() }
  unknownWildcard()
  return ImportedWorker.create()
}
