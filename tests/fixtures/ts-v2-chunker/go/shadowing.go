package sample

func target() {}

func Shadowing(factory func() func()) {
	target := func() {
		target()
	}
	target()

	target = factory()
	target()

	target, extra := factory(), factory()
	target()
	extra()

	var first, second = factory(), factory()
	first()
	second()

	{
		nested := factory()
		nested()
	}
	nested()

	object.field = factory()
	object()
	values[0] = factory()
	values()
}
