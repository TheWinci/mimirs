package sample

import "fmt"
import tool "example.com/project/tool"
import (
	"strings"
	. "math"
	_ "example.com/project/driver"
)

func UseImports(value string) {
	fmt.Println(strings.TrimSpace(value))
	tool.Run()
	Println(Sqrt(4))
}
