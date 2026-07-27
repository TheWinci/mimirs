package fixtures.scope

import vendor.Worker as ImportedWorker

object Scope:
  val service = createService()

  def run(loader: () => String): Unit =
    loader()
    helper()
    service.execute()
    ImportedWorker.create()

    val callback = () => perform()
    callback()
    new LocalWorker(build())

  def helper(): Unit = ()

class LocalWorker(value: String)
