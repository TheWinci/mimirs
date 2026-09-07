package app

import project.Tools
import project.Job as Work
import project.Tools.run as execute
import project.build as make
import project.*

fun launch() {
  Tools.run()
  execute()
  Work()
  make()
  Local.start()
  Missing.run()
}
