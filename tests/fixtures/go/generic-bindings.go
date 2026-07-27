package sample

func GenericBindings[T ~string, F func() T](
	value string,
	factory F,
) (finish func()) {
	factory()
	finish()
	_ = T(value)
	_ = F(func() T {
		return T(value)
	})
	return
}

type Box[T ~string] struct{}

func (box Box[T]) Convert(value string) T {
	return T(value)
}

func LocalType(value string) string {
	type Converter string
	return string(Converter(value))
}
