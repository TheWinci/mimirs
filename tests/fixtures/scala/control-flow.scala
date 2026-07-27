object ControlFlow:
  def run(
    entries: List[() => Unit],
    pairs: List[(() => Unit, () => Unit)],
    fallback: () => Unit,
  ): Unit =
    for
      entry <- entries
      prepared = prepare(entry)
      if accept(prepared)
    do
      entry()
      prepared()

    for (first, second) <- pairs do
      first()
      second()
    first()

    entry()
    prepared()

    entries.foreach { current =>
      val (left, right) = pair(current)
      left()
      right()
    }
    current()
    left()

    lookup() match
      case Some(found) if validate(found) => found()
      case _ => fallback()
    found()

    try risky()
    catch
      case failure: RuntimeException => failure.getMessage()
    failure.getMessage()

class Factory(build: () => Unit):
  val current = build()

def helper(): Unit = ()

val scala2Reference = helper _
val scala3Reference = helper

def timing(replacement: () => Unit, holder: Holder): Unit =
  before()
  val before = () => helper()
  before()

  var callback = () => helper()
  callback()
  callback = replacement
  callback()

  holder.callback = replacement
  holder.callback()
