package fixtures.modern:
  enum State:
    case Ready, Done
    case Failed(code: Int, message: String)

    def label: String = format(this)

  given ordering: Ordering[State] with
    def compare(left: State, right: State): Int = compareState(left, right)

  extension (value: String)
    def normalized: String = clean(value)

  opaque type UserId = String
