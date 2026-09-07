# File documentation stays separate.

# Coordinates work.
class Coordinator
  # Current worker.
  WORKER = create_worker()

  # Runs one unit of work.
  def run
    # Keep delegation visible.
    WORKER.call()
  end
end
