class ReportEntry {
  const ReportEntry(this.title, this.owner);

  final String title;
  final String? owner;
}

/// Keep report entries in insertion order.
class ReportBook {
  final List<ReportEntry> _entries = [];

  void add(String title, String? owner) {
    _entries.add(ReportEntry(title, owner));
  }

  List<String> render() {
    return _entries.map((entry) {
      final owner = entry.owner ?? 'unassigned';
      return '${entry.title} — $owner';
    }).toList();
  }

  int get size => _entries.length;
}

extension ReportEntryLabel on ReportEntry {
  String get label => '$title:${owner ?? 'unassigned'}';
}
