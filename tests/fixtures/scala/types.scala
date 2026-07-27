package fixtures.types

trait Service[A]:
  def run(value: A): String

case class User(name: String, age: Int = 0)

class Config(val path: String, raw: String):
  val client = Client.create()
  var retries = 0

object Worker extends Service[String]:
  val DefaultLimit = loadLimit()

  def run(value: String): String = transform(value)

package object legacy:
  val Enabled = true
