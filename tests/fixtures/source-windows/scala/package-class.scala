package windows

final case class ReportEntry(title: String, owner: Option[String])

/** Keep report entries in insertion order. */
final class ReportBook:
  private var entries = Vector.empty[ReportEntry]

  def add(title: String, owner: Option[String]): Unit =
    entries = entries :+ ReportEntry(title, owner)

  def render: Vector[String] =
    entries.map { entry =>
      val owner = entry.owner.getOrElse("unassigned")
      s"${entry.title} — $owner"
    }

  def size: Int = entries.size
