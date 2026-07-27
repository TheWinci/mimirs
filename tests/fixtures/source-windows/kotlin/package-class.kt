package windows

data class ReportEntry(val title: String, val owner: String?)

/** Keep report entries in insertion order. */
class ReportBook {
    private val entries = mutableListOf<ReportEntry>()

    fun add(title: String, owner: String?) {
        entries += ReportEntry(title, owner)
    }

    fun render(): List<String> = entries.map { entry ->
        val owner = entry.owner ?: "unassigned"
        "${entry.title} — $owner"
    }

    val size: Int
        get() = entries.size
}
