import java.nio.file.{Files, Path}

final case class Report(name: String, body: String)

def loadReport(path: Path): Report =
  val body = Files.readString(path)
  Report(path.getFileName.toString, body)

val report = loadReport(Path.of("report.md"))
println(s"${report.name}: ${report.body.length}")
