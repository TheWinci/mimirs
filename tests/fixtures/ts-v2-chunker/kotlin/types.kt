package fixtures.types

data class User(val name: String, var age: Int = 0)

@JvmInline
value class UserId(val value: String)

sealed interface State {
  fun describe(): String
}

enum class Color {
  RED,
  BLUE;

  fun label(): String = format(name)
}

annotation class Marker(val value: String)

object Registry {
  const val LIMIT = 10
  fun create(): Service = Service(resolve())
}

class Service(
  private val client: Client,
  name: String,
) : Base(name) {
  companion object Factory {
    fun default(): Service = Service(defaultClient())
  }

  constructor() : this(defaultClient(), "default") {
    initialize()
  }

  val title: String
    get() = loadTitle()

  var status: String = clean("new")
    set(value) {
      field = value.trim()
    }

  init {
    register(client)
  }

  fun run(value: String): Result = client.execute(value)
}

typealias Handler = (String) -> Unit
