package main

import (
	"fmt"
	"example.com/project/internal/mathx"
	worker "example.com/project/internal/worker"
	. "example.com/project/internal/dot"
	_ "example.com/project/internal/driver"
	"example.com/project/internal/model"
	missing "example.com/project/missing"
)

func Start() {
	local()
	fmt.Println(calc.Add(1, 2), worker.Run(), Dot(), model.ID("id"), missing.Run())
}

func local() {}
