package windows;

import java.util.ArrayList;
import java.util.List;

/** Keep report entries in insertion order. */
public final class ReportBook {
  private final List<Entry> entries = new ArrayList<>();

  public void add(String title, String owner) {
    entries.add(new Entry(title, owner));
  }

  public List<String> render() {
    return entries.stream()
        .map(entry -> entry.title() + " — " + entry.owner())
        .toList();
  }

  public int size() {
    return entries.size();
  }

  public record Entry(String title, String owner) {
    public Entry {
      owner = owner == null ? "unassigned" : owner;
    }
  }
}
