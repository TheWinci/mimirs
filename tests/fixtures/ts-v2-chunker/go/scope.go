package sample

import runner "example.com/project/runner"

func Execute(run func()) {
	run()
	runner.Run()
}

func Start() {
	helper()
}

func helper() {}
