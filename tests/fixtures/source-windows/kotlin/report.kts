import java.nio.file.Files
import java.nio.file.Path

data class Report(val name: String, val body: String)

fun loadReport(path: Path): Report {
    val body = Files.readString(path)
    return Report(path.fileName.toString(), body)
}

val report = loadReport(Path.of("report.md"))
println("${report.name}: ${report.body.length}")
