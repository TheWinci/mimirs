import java.nio.file.Path

val root = Path.of(".")

fun label(path: Path): String = path.fileName.toString()

println(label(root))
