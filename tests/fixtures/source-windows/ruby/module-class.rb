module Windows
  # Keep report entries in insertion order.
  class ReportBook
    def initialize
      @entries = []
    end

    def add(title, owner)
      @entries << { title: title, owner: owner }
    end

    def render
      @entries.map do |entry|
        owner = entry[:owner] || "unassigned"
        "#{entry[:title]} — #{owner}"
      end
    end

    def size
      @entries.length
    end
  end
end
