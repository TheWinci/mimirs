/** File documentation stays separate. */
package fixtures.comments

// Attached to the class.
@Deprecated("fixture")
class Documented {
  /** Attached to the method. */
  fun render(): String = buildText()

  // This comment stays with the property.
  val title: String = loadTitle()
}
