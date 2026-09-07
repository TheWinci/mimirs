package fixtures.imports

import scala.collection.mutable
import scala.util.{Try, Success => Ok, Failure => _}
import helpers._
import scala.concurrent.{Future as Async, *}
import ordering.given
import ordering.{given Ordering, given Conversion, *}

object Imports:
  def run(): Unit =
    Ok(1)
    mutable.Map()
    Async.successful(1)
    unknownWildcard()
