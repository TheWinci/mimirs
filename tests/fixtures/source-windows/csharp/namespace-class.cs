using System.Collections.Generic;

namespace Windows
{
    /// <summary>Keep report entries in insertion order.</summary>
    public sealed class ReportBook
    {
        private readonly List<Entry> entries = [];

        public void Add(string title, string owner)
        {
            entries.Add(new Entry(title, owner));
        }

        public IReadOnlyList<string> Render()
        {
            return entries.ConvertAll(
                entry => $"{entry.Title} — {entry.Owner}");
        }

        public int Count => entries.Count;

        private sealed record Entry(string Title, string Owner);
    }
}
