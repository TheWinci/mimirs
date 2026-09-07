def make(): Unit = ()

val callback = () => make()
callback()

if true then
  val nested = () => make()
  nested()

make()
nested()

val reference = make _
