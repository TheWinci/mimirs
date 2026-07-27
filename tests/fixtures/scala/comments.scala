// File documentation stays separate.

/** Coordinates work. */
@deprecated("fixture", "1.0")
class Coordinator:
  /** Current worker. */
  val worker = createWorker()

  /** Runs one unit of work. */
  def run(): Unit =
    // Keep delegation visible.
    worker.run()
