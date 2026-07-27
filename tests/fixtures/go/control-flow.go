package sample

func ControlFlow(
	source func() func(),
	condition func() bool,
	values []func(),
	channel chan func(),
	dynamic any,
) {
	if selected := source(); condition() {
		branch := source()
		branch()
		selected()
	} else {
		selected()
	}
	selected()

	for loop := source(); condition(); loop = source() {
		loop()
	}
	loop()

	for _, item := range values {
		item()
	}
	item()

	var reused func()
	for reused = range channel {
		reused()
	}

	switch choice := source(); condition() {
	case true:
		choice()
	}

	switch initial := source(); current := dynamic.(type) {
	case func():
		initial()
		current()
	default:
		initial()
		current()
	}
	initial()
	current()

	select {
	case received := <-channel:
		received()
	case channel <- source():
		sent()
	}
	received()
}
